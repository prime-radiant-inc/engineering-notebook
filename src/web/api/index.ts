import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "fs";
import { dirname } from "path";
import { parseStructuredTranscript } from "../../transcript-structured";
import { discoverSubagents, subagentFilePath } from "../../subagents";

/** JSON API consumed by the React frontend (mounted at /api). */
export function createApiRouter(db: Database): Hono {
  const api = new Hono();
  api.get("/ping", (c) => c.json({ ok: true }));

  api.get("/sessions/:id/transcript", (c) => {
    const id = c.req.param("id");
    const row = db.query("SELECT source_path FROM sessions WHERE id = ?").get(id) as { source_path: string } | null;
    if (!row) return c.json({ error: "session not found" }, 404);
    if (!row.source_path || !existsSync(row.source_path)) return c.json({ error: "source unavailable" }, 410);
    return c.json(parseStructuredTranscript(readFileSync(row.source_path, "utf-8")));
  });

  api.get("/sessions/:id", (c) => {
    const id = c.req.param("id");
    const row = db.query("SELECT id, project_id, project_path, source_path, started_at, ended_at, message_count, git_branch FROM sessions WHERE id = ?").get(id) as any;
    if (!row) return c.json({ error: "session not found" }, 404);
    const subagents = row.source_path ? discoverSubagents(dirname(row.source_path), id) : [];
    return c.json({ ...row, subagents });
  });

  api.get("/sessions", (c) => {
    const rawLimit = parseInt(c.req.query("limit") ?? "", 10);
    const limit = Number.isNaN(rawLimit) ? 50 : Math.max(0, Math.min(rawLimit, 200));
    const rawOffset = parseInt(c.req.query("offset") ?? "", 10);
    const offset = Number.isNaN(rawOffset) ? 0 : Math.max(0, rawOffset);
    const project = c.req.query("project");
    const where = project ? "WHERE s.project_id = ?" : "";
    const args = project ? [project] : [];
    const total = (db.query(`SELECT COUNT(*) c FROM sessions s ${where}`).get(...args) as { c: number }).c;
    const sessions = db.query(
      `SELECT s.id, s.project_id, p.display_name, s.started_at, s.ended_at, s.message_count, s.is_subagent
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
