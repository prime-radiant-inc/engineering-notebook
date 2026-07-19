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

  api.get("/subagent/:sessionId/:agentId", (c) => {
    const { sessionId, agentId } = c.req.param();
    const row = db.query("SELECT source_path FROM sessions WHERE id = ?").get(sessionId) as { source_path: string } | null;
    if (!row) return c.json({ error: "session not found" }, 404);
    const path = subagentFilePath(dirname(row.source_path), sessionId, agentId);
    if (!existsSync(path)) return c.json({ error: "subagent not found" }, 404);
    return c.json(parseStructuredTranscript(readFileSync(path, "utf-8")));
  });

  return api;
}
