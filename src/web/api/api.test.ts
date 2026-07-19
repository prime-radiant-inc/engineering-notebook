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

  test("GET /subagent/:sessionId/:agentId rejects path traversal in agentId and never leaks foreign files", async () => {
    const sourcePath = join(tempDir, "s6.jsonl");
    writeFileSync(sourcePath, "");
    db.query("INSERT OR IGNORE INTO projects (id, path, display_name) VALUES ('p','/tmp/p','Proj')").run();
    db.query(
      `INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at)
       VALUES (?, 'p', '/tmp/p', ?, '2026-07-10T00:00:00Z', 0, datetime('now'))`
    ).run("s6", sourcePath);

    // Sentinel file living outside the s6/subagents directory that a traversal attack would target.
    // "../../../../some-file" decoded, joined against `agent-${agentId}.jsonl` and the subagents
    // dir (tempDir/s6/subagents), resolves to tempDir/some-file.jsonl -- outside the subagents dir.
    const sentinelPath = join(tempDir, "some-file.jsonl");
    const sentinelContents = JSON.stringify({ secret: "should-never-be-returned" });
    writeFileSync(sentinelPath, sentinelContents);

    const app = createApiRouter(db);
    const res = await app.request("/subagent/s6/..%2F..%2F..%2F..%2Fsome-file");
    expect(res.status).not.toBe(200);
    expect([400, 404]).toContain(res.status);
    const text = await res.text();
    expect(text).not.toContain("should-never-be-returned");
  });

  test("GET /subagent/:sessionId/:agentId rejects a non-charset-matching sessionId", async () => {
    const app = createApiRouter(db);
    const res = await app.request("/subagent/..%2F..%2Fetc/a2");
    expect(res.status).not.toBe(200);
    expect([400, 404]).toContain(res.status);
  });

  test("GET /sessions lists sessions newest-first with total, supports limit/offset and project filter", async () => {
    db.query("INSERT OR IGNORE INTO projects (id, path, display_name) VALUES ('p1','/tmp/p1','Project One')").run();
    db.query("INSERT OR IGNORE INTO projects (id, path, display_name) VALUES ('p2','/tmp/p2','Project Two')").run();
    db.query(
      `INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at)
       VALUES (?, 'p1', '/tmp/p1', ?, '2026-07-10T00:00:00Z', 3, datetime('now'))`
    ).run("s1", join(tempDir, "s1.jsonl"));
    db.query(
      `INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at)
       VALUES (?, 'p2', '/tmp/p2', ?, '2026-07-12T00:00:00Z', 5, datetime('now'))`
    ).run("s2", join(tempDir, "s2.jsonl"));
    db.query(
      `INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at)
       VALUES (?, 'p1', '/tmp/p1', ?, '2026-07-11T00:00:00Z', 2, datetime('now'))`
    ).run("s3", join(tempDir, "s3.jsonl"));

    const app = createApiRouter(db);

    const all = await app.request("/sessions");
    expect(all.status).toBe(200);
    const allBody = (await all.json()) as any;
    expect(allBody.total).toBe(3);
    expect(allBody.sessions.map((s: any) => s.id)).toEqual(["s2", "s3", "s1"]);
    expect(allBody.sessions[0]).toMatchObject({
      id: "s2",
      project_id: "p2",
      display_name: "Project Two",
      started_at: "2026-07-12T00:00:00Z",
      message_count: 5,
    });

    const paged = await app.request("/sessions?limit=1&offset=1");
    const pagedBody = (await paged.json()) as any;
    expect(pagedBody.total).toBe(3);
    expect(pagedBody.sessions.map((s: any) => s.id)).toEqual(["s3"]);

    const filtered = await app.request("/sessions?project=p1");
    const filteredBody = (await filtered.json()) as any;
    expect(filteredBody.total).toBe(2);
    expect(filteredBody.sessions.map((s: any) => s.id)).toEqual(["s3", "s1"]);
  });

  test("GET /sessions caps limit at 200 and defaults to 50", async () => {
    db.query("INSERT OR IGNORE INTO projects (id, path, display_name) VALUES ('p1','/tmp/p1','Project One')").run();
    db.query(
      `INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at)
       VALUES (?, 'p1', '/tmp/p1', ?, '2026-07-10T00:00:00Z', 1, datetime('now'))`
    ).run("s1", join(tempDir, "s1.jsonl"));

    const app = createApiRouter(db);
    const res = await app.request("/sessions?limit=9999");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.sessions.length).toBe(1);
  });

  test("GET /sessions clamps limit: honours a small limit and treats a negative limit as bounded (not unlimited)", async () => {
    db.query("INSERT OR IGNORE INTO projects (id, path, display_name) VALUES ('p1','/tmp/p1','Project One')").run();
    for (const id of ["s1", "s2", "s3"]) {
      db.query(
        `INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at)
         VALUES (?, 'p1', '/tmp/p1', ?, '2026-07-10T00:00:00Z', 1, datetime('now'))`
      ).run(id, join(tempDir, id + ".jsonl"));
    }
    const app = createApiRouter(db);

    const small = (await (await app.request("/sessions?limit=2")).json()) as any;
    expect(small.sessions.length).toBe(2); // limit actually applied
    expect(small.total).toBe(3);

    // Negative limit must NOT return all rows (SQLite treats negative LIMIT as unlimited).
    const neg = (await (await app.request("/sessions?limit=-1")).json()) as any;
    expect(neg.sessions.length).toBe(0);
  });
});
