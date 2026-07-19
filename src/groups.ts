import { Database } from "bun:sqlite";

export type GroupSummary = {
  id: number;
  name: string;
  sessionCount: number;
  lastActivityAt: string | null;
};

export type GroupSessionRow = {
  id: string;
  display_name: string;
  project_id: string;
  started_at: string;
  message_count: number;
  title: string | null;
};

function cleanName(name: string): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) throw new Error("Group name required");
  return trimmed;
}

export function createGroup(db: Database, name: string): number {
  const clean = cleanName(name);
  try {
    const row = db
      .query("INSERT INTO groups (name, created_at) VALUES (?, datetime('now')) RETURNING id")
      .get(clean) as { id: number };
    return row.id;
  } catch (err) {
    if (err instanceof Error && (err as any).code === "SQLITE_CONSTRAINT_UNIQUE") {
      throw new Error("Group name already exists");
    }
    throw err;
  }
}

export function renameGroup(db: Database, id: number, name: string): void {
  const clean = cleanName(name);
  try {
    db.query("UPDATE groups SET name = ? WHERE id = ?").run(clean, id);
  } catch (err) {
    if (err instanceof Error && (err as any).code === "SQLITE_CONSTRAINT_UNIQUE") {
      throw new Error("Group name already exists");
    }
    throw err;
  }
}

export function deleteGroup(db: Database, id: number): void {
  db.query("DELETE FROM groups WHERE id = ?").run(id);
}

export function listGroups(db: Database): GroupSummary[] {
  return db
    .query(
      `SELECT g.id, g.name,
              COUNT(s.id) AS sessionCount,
              MAX(s.started_at) AS lastActivityAt
       FROM groups g
       LEFT JOIN session_groups sg ON sg.group_id = g.id
       LEFT JOIN sessions s ON s.id = sg.session_id
       GROUP BY g.id
       ORDER BY (lastActivityAt IS NULL), lastActivityAt DESC, g.name ASC`
    )
    .all() as GroupSummary[];
}

export function assignSession(db: Database, sessionId: string, groupId: number | null): void {
  if (groupId === null) {
    db.query("DELETE FROM session_groups WHERE session_id = ?").run(sessionId);
    return;
  }
  db.query(
    `INSERT INTO session_groups (session_id, group_id, assigned_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(session_id) DO UPDATE SET group_id = excluded.group_id, assigned_at = excluded.assigned_at`
  ).run(sessionId, groupId);
}

export function getSessionGroupId(db: Database, sessionId: string): number | null {
  const row = db
    .query("SELECT group_id FROM session_groups WHERE session_id = ?")
    .get(sessionId) as { group_id: number } | null;
  return row ? row.group_id : null;
}

export function getGroupWithSessions(
  db: Database,
  id: number
): { group: { id: number; name: string }; sessions: GroupSessionRow[] } | null {
  const group = db.query("SELECT id, name FROM groups WHERE id = ?").get(id) as
    | { id: number; name: string }
    | null;
  if (!group) return null;
  const sessions = db
    .query(
      `SELECT s.id, p.display_name, s.project_id, s.started_at, s.message_count, s.title
       FROM session_groups sg
       JOIN sessions s ON s.id = sg.session_id
       JOIN projects p ON p.id = s.project_id
       WHERE sg.group_id = ?
       ORDER BY s.started_at DESC`
    )
    .all(id) as GroupSessionRow[];
  return { group, sessions };
}

import type { DesktopGroupsData } from "./desktop-groups";

export type ImportSummary = {
  groupsAdded: number;
  groupsRenamed: number;
  groupsRemoved: number;
  sessionsAssigned: number;
  skippedNoSession: number;
  skippedNameCollision: number;
};

/** Import Claude Desktop groups: mirror by desktop_id; notebook-made groups untouched. */
export function importDesktopGroups(db: Database, data: DesktopGroupsData): ImportSummary {
  const summary: ImportSummary = {
    groupsAdded: 0, groupsRenamed: 0, groupsRemoved: 0,
    sessionsAssigned: 0, skippedNoSession: 0, skippedNameCollision: 0,
  };

  db.transaction(() => {
    const desktopIdToGroupId = new Map<string, number>();

    for (const g of data.groups) {
      const existing = db.query("SELECT id, name FROM groups WHERE desktop_id = ?").get(g.desktopId) as
        | { id: number; name: string } | null;
      if (existing) {
        if (existing.name !== g.name) {
          const clash = db.query("SELECT id FROM groups WHERE name = ? AND id != ?").get(g.name, existing.id) as { id: number } | null;
          if (!clash) { db.query("UPDATE groups SET name = ? WHERE id = ?").run(g.name, existing.id); summary.groupsRenamed++; }
        }
        desktopIdToGroupId.set(g.desktopId, existing.id);
      } else {
        const clash = db.query("SELECT id FROM groups WHERE name = ?").get(g.name) as { id: number } | null;
        if (clash) { summary.skippedNameCollision++; continue; }
        const row = db.query(
          "INSERT INTO groups (name, created_at, desktop_id) VALUES (?, datetime('now'), ?) RETURNING id"
        ).get(g.name, g.desktopId) as { id: number };
        desktopIdToGroupId.set(g.desktopId, row.id);
        summary.groupsAdded++;
      }
    }

    const present = new Set(data.groups.map((g) => g.desktopId));
    for (const eg of db.query("SELECT id, desktop_id FROM groups WHERE desktop_id IS NOT NULL").all() as { id: number; desktop_id: string }[]) {
      if (!present.has(eg.desktop_id)) { db.query("DELETE FROM groups WHERE id = ?").run(eg.id); summary.groupsRemoved++; }
    }

    // Mirror membership for desktop groups.
    db.query("DELETE FROM session_groups WHERE group_id IN (SELECT id FROM groups WHERE desktop_id IS NOT NULL)").run();
    for (const a of data.assignments) {
      const gid = desktopIdToGroupId.get(a.desktopGroupId);
      if (gid === undefined) continue;
      const sess = db.query("SELECT id FROM sessions WHERE id = ?").get(a.cliSessionId);
      if (!sess) { summary.skippedNoSession++; continue; }
      db.query(
        `INSERT INTO session_groups (session_id, group_id, assigned_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(session_id) DO UPDATE SET group_id = excluded.group_id, assigned_at = excluded.assigned_at`
      ).run(a.cliSessionId, gid);
      summary.sessionsAssigned++;
    }
  })();

  return summary;
}

/** Sessions with no group, most-recent first. */
export function listUngroupedSessions(db: Database, limit = 200, offset = 0): { sessions: GroupSessionRow[]; total: number } {
  const total = (db.query(
    `SELECT COUNT(*) c FROM sessions s WHERE NOT EXISTS (SELECT 1 FROM session_groups sg WHERE sg.session_id = s.id)`
  ).get() as { c: number }).c;
  const sessions = db.query(
    `SELECT s.id, p.display_name, s.project_id, s.started_at, s.message_count, s.title
     FROM sessions s JOIN projects p ON p.id = s.project_id
     WHERE NOT EXISTS (SELECT 1 FROM session_groups sg WHERE sg.session_id = s.id)
     ORDER BY s.started_at DESC LIMIT ? OFFSET ?`
  ).all(limit, offset) as GroupSessionRow[];
  return { sessions, total };
}
