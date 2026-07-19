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
    const row = db.query("SELECT id, project_id, project_path, source_path, started_at, ended_at, message_count FROM sessions WHERE id = ?").get(id) as any;
    if (!row) return c.json({ error: "session not found" }, 404);
    const subagents = row.source_path ? discoverSubagents(dirname(row.source_path), id) : [];
    return c.json({ ...row, subagents });
  });

  api.get("/sessions", (c) => {
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10) || 50, 200);
    const offset = parseInt(c.req.query("offset") || "0", 10) || 0;
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
