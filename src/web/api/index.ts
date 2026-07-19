import { Hono } from "hono";
import { Database } from "bun:sqlite";

/** JSON API consumed by the React frontend (mounted at /api). */
export function createApiRouter(db: Database): Hono {
  const api = new Hono();
  api.get("/ping", (c) => c.json({ ok: true }));
  return api;
}
