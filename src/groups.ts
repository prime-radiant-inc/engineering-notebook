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
    if (String(err).includes("UNIQUE")) throw new Error("Group name already exists");
    throw err;
  }
}

export function renameGroup(db: Database, id: number, name: string): void {
  const clean = cleanName(name);
  try {
    db.query("UPDATE groups SET name = ? WHERE id = ?").run(clean, id);
  } catch (err) {
    if (String(err).includes("UNIQUE")) throw new Error("Group name already exists");
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
      `SELECT s.id, p.display_name, s.project_id, s.started_at, s.message_count
       FROM session_groups sg
       JOIN sessions s ON s.id = sg.session_id
       JOIN projects p ON p.id = s.project_id
       WHERE sg.group_id = ?
       ORDER BY s.started_at DESC`
    )
    .all(id) as GroupSessionRow[];
  return { group, sessions };
}
