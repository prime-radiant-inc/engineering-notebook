import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../../db";
import { createApiRouter } from "./index";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
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

  test("GET /sessions/:id returns metadata + discovered subagents", async () => {
    const sourcePath = join(tempDir, "s3.jsonl");
    writeFileSync(sourcePath, JSON.stringify({ type: "assistant", uuid: "u1", parentUuid: null, timestamp: "t1", message: { content: [{ type: "text", text: "hi" }] } }));
    const subDir = join(tempDir, "s3", "subagents");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "agent-a1.jsonl"), JSON.stringify({ type: "assistant" }) + "\n");
    writeFileSync(join(subDir, "agent-a1.meta.json"), JSON.stringify({
      agentType: "general-purpose", description: "Investigate widget bug", toolUseId: "toolu_1", spawnDepth: 1,
    }));

    db.query("INSERT OR IGNORE INTO projects (id, path, display_name) VALUES ('p','/tmp/p','Proj')").run();
    db.query(
      `INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at)
       VALUES (?, 'p', '/tmp/p', ?, '2026-07-10T00:00:00Z', 1, datetime('now'))`
    ).run("s3", sourcePath);

    const app = createApiRouter(db);
    const res = await app.request("/sessions/s3");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toBe("s3");
    expect(body.project_id).toBe("p");
    expect(body.subagents).toEqual([
      { agentId: "a1", agentType: "general-purpose", description: "Investigate widget bug", toolUseId: "toolu_1", spawnDepth: 1 },
    ]);
  });

  test("GET /sessions/:id 404s for missing session", async () => {
    const app = createApiRouter(db);
    const res = await app.request("/sessions/nope");
    expect(res.status).toBe(404);
  });

  test("GET /subagent/:sessionId/:agentId returns the subagent's structured transcript", async () => {
    const sourcePath = join(tempDir, "s4.jsonl");
    writeFileSync(sourcePath, "");
    const subDir = join(tempDir, "s4", "subagents");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, "agent-a2.jsonl"),
      JSON.stringify({ type: "assistant", uuid: "su1", parentUuid: null, timestamp: "st1", message: { content: [{ type: "text", text: "sub hi" }] } })
    );

    db.query("INSERT OR IGNORE INTO projects (id, path, display_name) VALUES ('p','/tmp/p','Proj')").run();
    db.query(
      `INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at)
       VALUES (?, 'p', '/tmp/p', ?, '2026-07-10T00:00:00Z', 0, datetime('now'))`
    ).run("s4", sourcePath);

    const app = createApiRouter(db);
    const res = await app.request("/subagent/s4/a2");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      messages: [
        { role: "assistant", uuid: "su1", parentUuid: null, timestamp: "st1", blocks: [{ kind: "text", content: "sub hi" }] },
      ],
      format: "claude",
    });
  });

  test("GET /subagent/:sessionId/:agentId 404s for missing session", async () => {
    const app = createApiRouter(db);
    const res = await app.request("/subagent/nope/a2");
    expect(res.status).toBe(404);
  });

  test("GET /subagent/:sessionId/:agentId 404s for missing agent file", async () => {
    const sourcePath = join(tempDir, "s5.jsonl");
    writeFileSync(sourcePath, "");
    db.query("INSERT OR IGNORE INTO projects (id, path, display_name) VALUES ('p','/tmp/p','Proj')").run();
    db.query(
      `INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at)
       VALUES (?, 'p', '/tmp/p', ?, '2026-07-10T00:00:00Z', 0, datetime('now'))`
    ).run("s5", sourcePath);

    const app = createApiRouter(db);
    const res = await app.request("/subagent/s5/missing-agent");
    expect(res.status).toBe(404);
  });
});
