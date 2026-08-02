import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "fs";
import { dirname } from "path";
import { parseStructuredTranscript } from "../../transcript-structured";
import { discoverSubagents, subagentFilePath } from "../../subagents";
import { listGroups, getGroupWithSessions, listUngroupedSessions, importDesktopGroups, assignSession } from "../../groups";
import { readDesktopGroups, isClaudeDesktopRunning } from "../../desktop-groups";
import { applyDesktopTitles, titleSession } from "../../titles";

type SubagentRef = { id: string; agentType?: string; description?: string };
type SessionRef = { id: string; title: string | null; subagents: SubagentRef[] };

type EnrichedSubagent = { agentId: string; agentType?: string; description?: string; toolUseId?: string; spawnDepth?: number; started_at: string };

/**
 * A session's subagents that are ALSO ingested (i.e. reachable via /sessions/:id),
 * enriched with each one's start time and ordered chronologically (ISO strings
 * sort lexicographically). Discovering from disk but filtering to ingested rows
 * avoids dead links from subagent files that were skipped at ingest, and uses a
 * single batched query for start times (no per-subagent round-trip).
 */
function ingestedSubagents(db: Database, parentSessionId: string): EnrichedSubagent[] {
  const row = db.query("SELECT source_path FROM sessions WHERE id = ?").get(parentSessionId) as { source_path: string } | null;
  if (!row?.source_path) return [];
  const discovered = discoverSubagents(dirname(row.source_path), parentSessionId);
  if (discovered.length === 0) return [];
  const ids = discovered.map((s) => `agent-${s.agentId}`);
  const rows = db
    .query(`SELECT id, started_at FROM sessions WHERE id IN (${ids.map(() => "?").join(",")})`)
    .all(...ids) as { id: string; started_at: string | null }[];
  const startById = new Map(rows.map((r) => [r.id, r.started_at ?? ""]));
  return discovered
    .filter((s) => startById.has(`agent-${s.agentId}`)) // only ingested → no dead links
    .map((s) => ({ ...s, started_at: startById.get(`agent-${s.agentId}`)! }))
    .sort((a, b) => a.started_at.localeCompare(b.started_at));
}

/** The nested-list shape ({ id, agentType, description }) for a session's subagents. */
function subagentsForSession(db: Database, id: string): SubagentRef[] {
  return ingestedSubagents(db, id).map((s) => ({ id: `agent-${s.agentId}`, agentType: s.agentType, description: s.description }));
}

/** Resolve session ids to { id, title, subagents }. */
function resolveSessions(db: Database, ids: string[]): SessionRef[] {
  return ids.map((id) => {
    const row = db.query("SELECT title FROM sessions WHERE id = ?").get(id) as { title: string | null } | null;
    return { id, title: row?.title ?? null, subagents: subagentsForSession(db, id) };
  });
}

/** JSON API consumed by the React frontend (mounted at /api). */
export function createApiRouter(db: Database): Hono {
  const api = new Hono();
  api.get("/ping", (c) => c.json({ ok: true }));

  // ── Projects ──
  api.get("/projects", (c) => {
    const rows = db.query(
      `SELECT id, display_name, last_session_at, session_count FROM projects ORDER BY last_session_at DESC`
    ).all();
    return c.json({ projects: rows });
  });

  api.get("/projects/:id/entries", (c) => {
    const id = c.req.param("id");
    const parse = (s: string) => { try { return JSON.parse(s || "[]"); } catch { return []; } };
    const rows = db.query(
      `SELECT je.id, je.date, je.headline, je.summary, je.topics, je.session_ids, je.open_questions
       FROM journal_entries je WHERE je.project_id = ? AND je.headline != '' ORDER BY je.date DESC`
    ).all(id) as any[];
    return c.json({
      entries: rows.map((e) => ({
        id: e.id, date: e.date, headline: e.headline, summary: e.summary,
        topics: parse(e.topics), open_questions: parse(e.open_questions), session_ids: parse(e.session_ids),
        sessions: resolveSessions(db, parse(e.session_ids)),
      })),
    });
  });

  // ── Calendar ── activity per date for a month (YYYY-MM)
  api.get("/calendar", (c) => {
    const month = c.req.query("month"); // YYYY-MM
    const where = month ? "WHERE je.date LIKE ? AND je.headline != ''" : "WHERE je.headline != ''";
    const args = month ? [`${month}-%`] : [];
    const rows = db.query(
      `SELECT je.date AS date, COUNT(*) AS entries, GROUP_CONCAT(DISTINCT p.display_name) AS projects
       FROM journal_entries je JOIN projects p ON je.project_id = p.id ${where}
       GROUP BY je.date ORDER BY je.date`
    ).all(...args) as { date: string; entries: number; projects: string }[];
    return c.json({
      days: rows.map((r) => ({ date: r.date, entries: r.entries, projects: (r.projects || "").split(",").map((s) => s.trim()).filter(Boolean) })),
    });
  });

  // ── Groups ──
  api.get("/groups", (c) => c.json({ groups: listGroups(db), desktopRunning: isClaudeDesktopRunning() }));

  api.get("/groups/ungrouped", (c) => {
    const limit = Math.max(0, Math.min(parseInt(c.req.query("limit") || "200", 10) || 200, 500));
    const offset = Math.max(0, parseInt(c.req.query("offset") || "0", 10) || 0);
    const r = listUngroupedSessions(db, limit, offset);
    return c.json({ ...r, sessions: r.sessions.map((s) => ({ ...s, subagents: subagentsForSession(db, s.id) })) });
  });

  api.get("/groups/:id", (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const data = isNaN(id) ? null : getGroupWithSessions(db, id);
    if (!data) return c.json({ error: "group not found" }, 404);
    return c.json({ ...data, sessions: data.sessions.map((s) => ({ ...s, subagents: subagentsForSession(db, s.id) })) });
  });

  // Assign a session to a group ({ groupId: number }) or unassign it ({ groupId: null }).
  api.post("/sessions/:id/group", async (c) => {
    const id = c.req.param("id");
    if (!db.query("SELECT id FROM sessions WHERE id = ?").get(id)) return c.json({ error: "session not found" }, 404);
    let body: { groupId?: number | null };
    try { body = await c.req.json(); } catch { body = {}; }
    const raw = body?.groupId;
    const groupId = raw === null || raw === undefined ? null : Number(raw);
    if (groupId !== null) {
      if (Number.isNaN(groupId) || !db.query("SELECT id FROM groups WHERE id = ?").get(groupId)) {
        return c.json({ error: "group not found" }, 404);
      }
    }
    assignSession(db, id, groupId);
    return c.json({ ok: true, sessionId: id, groupId });
  });

  // Generate + store a title for one Claude Code session that lacks one.
  api.post("/sessions/:id/title", async (c) => {
    const id = c.req.param("id");
    const exists = db.query("SELECT title FROM sessions WHERE id = ?").get(id) as { title: string | null } | null;
    if (!exists) return c.json({ error: "session not found" }, 404);
    try {
      const title = await titleSession(db, id);
      if (!title) return c.json({ error: "no content to title" }, 422);
      return c.json({ id, title, title_source: "generated" });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  api.post("/groups/import-desktop", async (c) => {
    try {
      const data = await readDesktopGroups();
      if (!data) return c.json({ imported: false, message: "No Claude Desktop groups found." });
      const summary = importDesktopGroups(db, data);
      const titled = applyDesktopTitles(db); // capture Desktop session names too
      return c.json({ imported: true, summary: { ...summary, titlesApplied: titled } });
    } catch (err) {
      return c.json({ imported: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  api.get("/sessions/:id/transcript", (c) => {
    const id = c.req.param("id");
    const full = c.req.query("full") === "1"; // uncompacted: every message, incl. pre-compaction
    const row = db.query("SELECT source_path FROM sessions WHERE id = ?").get(id) as { source_path: string } | null;
    if (!row) return c.json({ error: "session not found" }, 404);
    if (!row.source_path || !existsSync(row.source_path)) return c.json({ error: "source unavailable" }, 410);
    return c.json(parseStructuredTranscript(readFileSync(row.source_path, "utf-8"), { full }));
  });

  api.get("/sessions/:id", (c) => {
    const id = c.req.param("id");
    const row = db.query("SELECT id, project_id, project_path, source_path, started_at, ended_at, message_count, git_branch, title, title_source, parent_session_id, is_subagent FROM sessions WHERE id = ?").get(id) as any;
    if (!row) return c.json({ error: "session not found" }, 404);
    // Ingested subagents, enriched with start time and ordered chronologically —
    // this list is the compaction-proof index in panel 3, independent of what
    // survives on the active transcript path.
    const subagents = ingestedSubagents(db, id);
    // Backlink: the title of the session that spawned this subagent. Only for
    // subagents — a resumed/continued top-level session also has a
    // parent_session_id, but it is NOT a subagent and must not show a backlink.
    const parent = row.is_subagent && row.parent_session_id
      ? (db.query("SELECT title FROM sessions WHERE id = ?").get(row.parent_session_id) as { title: string | null } | null)
      : null;
    // A subagent's own "title" is its subtask description (from the sibling meta),
    // shown in panel 3 in place of the raw first prompt. No agent-type prefix.
    let subtask_title: string | null = null;
    // The parent tool_use id that spawned this subagent — used to scroll the
    // parent transcript back to the exact spawn point on backlink navigation.
    let spawn_tool_use_id: string | null = null;
    if (row.is_subagent && typeof row.source_path === "string" && row.source_path.endsWith(".jsonl")) {
      const metaPath = row.source_path.replace(/\.jsonl$/, ".meta.json");
      if (existsSync(metaPath)) {
        try {
          const m = JSON.parse(readFileSync(metaPath, "utf-8"));
          if (typeof m.description === "string" && m.description.trim()) subtask_title = m.description.trim();
          if (typeof m.toolUseId === "string" && m.toolUseId) spawn_tool_use_id = m.toolUseId;
        } catch { /* ignore malformed meta */ }
      }
    }
    return c.json({ ...row, parent_title: parent?.title ?? null, subtask_title, spawn_tool_use_id, subagents });
  });

  api.get("/sessions", (c) => {
    const rawLimit = parseInt(c.req.query("limit") ?? "", 10);
    const limit = Number.isNaN(rawLimit) ? 50 : Math.max(0, Math.min(rawLimit, 200));
    const rawOffset = parseInt(c.req.query("offset") ?? "", 10);
    const offset = Number.isNaN(rawOffset) ? 0 : Math.max(0, rawOffset);
    const project = c.req.query("project");
    // Subagents are not standalone sessions — exclude them from the flat list.
    const clauses = ["COALESCE(s.is_subagent, 0) = 0"];
    if (project) clauses.push("s.project_id = ?");
    const where = "WHERE " + clauses.join(" AND ");
    const args = project ? [project] : [];
    const total = (db.query(`SELECT COUNT(*) c FROM sessions s ${where}`).get(...args) as { c: number }).c;
    const sessions = db.query(
      `SELECT s.id, s.project_id, p.display_name, s.started_at, s.ended_at, s.message_count, s.is_subagent, s.title
       FROM sessions s JOIN projects p ON p.id = s.project_id ${where}
       ORDER BY s.started_at DESC LIMIT ? OFFSET ?`
    ).all(...args, limit, offset);
    return c.json({ sessions, total });
  });

  // Journal: dates that have summarized entries (panel 1)
  api.get("/journal/dates", (c) => {
    const rows = db.query(`
      SELECT je.date AS date, GROUP_CONCAT(DISTINCT p.display_name) AS projects
      FROM journal_entries je JOIN projects p ON je.project_id = p.id
      WHERE je.headline != ''
      GROUP BY je.date ORDER BY je.date DESC
    `).all() as { date: string; projects: string }[];
    return c.json({
      dates: rows.map((r) => ({ date: r.date, projects: (r.projects || "").split(",").map((s) => s.trim()).filter(Boolean) })),
    });
  });

  // Journal: entries (Claude summaries) for a date (panel 2)
  api.get("/journal/entries", (c) => {
    const date = c.req.query("date");
    if (!date) return c.json({ error: "missing date" }, 400);
    const rows = db.query(`
      SELECT je.id, je.date, je.project_id, p.display_name, je.headline, je.summary,
             je.topics, je.session_ids, je.open_questions
      FROM journal_entries je JOIN projects p ON je.project_id = p.id
      WHERE je.date = ? AND je.headline != ''
      ORDER BY p.display_name
    `).all(date) as any[];
    const parse = (s: string) => { try { return JSON.parse(s || "[]"); } catch { return []; } };
    return c.json({
      entries: rows.map((e) => ({
        id: e.id, date: e.date, project_id: e.project_id, display_name: e.display_name,
        headline: e.headline, summary: e.summary,
        topics: parse(e.topics), open_questions: parse(e.open_questions),
        session_ids: parse(e.session_ids),
        sessions: resolveSessions(db, parse(e.session_ids)),
      })),
    });
  });

  api.get("/subagent/:sessionId/:agentId", (c) => {
    const { sessionId, agentId } = c.req.param();
    const idPattern = /^[A-Za-z0-9_-]+$/;
    if (!idPattern.test(sessionId) || !idPattern.test(agentId)) {
      return c.json({ error: "invalid agent id" }, 400);
    }
    const row = db.query("SELECT source_path FROM sessions WHERE id = ?").get(sessionId) as { source_path: string } | null;
    if (!row) return c.json({ error: "session not found" }, 404);
    const path = subagentFilePath(dirname(row.source_path), sessionId, agentId);
    if (!path || !existsSync(path)) return c.json({ error: "subagent not found" }, 404);
    return c.json(parseStructuredTranscript(readFileSync(path, "utf-8")));
  });

  return api;
}
