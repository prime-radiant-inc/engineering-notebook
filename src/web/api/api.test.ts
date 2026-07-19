import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../../db";
import { createApiRouter } from "./index";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("api router", () => {
  let tempDir: string, db: ReturnType<typeof initDb>;
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), "api-")); db = initDb(join(tempDir, "t.db")); });
  afterEach(() => { closeDb(); rmSync(tempDir, { recursive: true, force: true }); });

  test("GET /api/ping returns ok", async () => {
    const app = createApiRouter(db);
    const res = await app.request("/ping");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("GET /sessions/:id/transcript returns structured messages", async () => {
    const sourcePath = join(tempDir, "session.jsonl");
    writeFileSync(sourcePath, [
      JSON.stringify({ type: "assistant", uuid: "u1", parentUuid: null, timestamp: "t1", message: { content: [
        { type: "text", text: "hi" },
      ] } }),
    ].join("\n"));
    db.query("INSERT OR IGNORE INTO projects (id, path, display_name) VALUES ('p','/tmp/p','Proj')").run();
    db.query(
      `INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at)
       VALUES (?, 'p', '/tmp/p', ?, '2026-07-10T00:00:00Z', 1, datetime('now'))`
    ).run("s1", sourcePath);

    const app = createApiRouter(db);
    const res = await app.request("/sessions/s1/transcript");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      messages: [
        { role: "assistant", uuid: "u1", parentUuid: null, timestamp: "t1", blocks: [{ kind: "text", content: "hi" }] },
      ],
      format: "claude",
    });
  });

  test("GET /sessions/:id/transcript 404s for missing session", async () => {
    const app = createApiRouter(db);
    const res = await app.request("/sessions/nope/transcript");
    expect(res.status).toBe(404);
  });

  test("GET /sessions/:id/transcript 410s for missing source file", async () => {
    db.query("INSERT OR IGNORE INTO projects (id, path, display_name) VALUES ('p','/tmp/p','Proj')").run();
    db.query(
      `INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at)
       VALUES (?, 'p', '/tmp/p', ?, '2026-07-10T00:00:00Z', 0, datetime('now'))`
    ).run("s2", join(tempDir, "missing.jsonl"));

    const app = createApiRouter(db);
    const res = await app.request("/sessions/s2/transcript");
    expect(res.status).toBe(410);
  });
});
