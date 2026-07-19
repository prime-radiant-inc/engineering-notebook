import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "fs";
import { parseStructuredTranscript } from "../../transcript-structured";

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

  return api;
}
