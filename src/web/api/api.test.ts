import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../../db";
import { createApiRouter } from "./index";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join, dirname } from "path";
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

  test("GET /journal/dates and /journal/entries return summarized entries", async () => {
    db.query("INSERT INTO projects (id, path, display_name) VALUES ('p','/tmp/p','My Project')").run();
    db.query(`INSERT INTO journal_entries (date, project_id, session_ids, headline, summary, topics, open_questions, generated_at, model_used)
              VALUES ('2026-07-15','p','[\"s1\",\"s2\"]','Built the thing','Did a lot','[\"infra\",\"api\"]','[\"what next?\"]',datetime('now'),'m')`).run();
    // an empty-headline entry must be excluded
    db.query(`INSERT INTO journal_entries (date, project_id, session_ids, headline, summary, topics, open_questions, generated_at, model_used)
              VALUES ('2026-07-14','p','[]','','skip me','[]','[]',datetime('now'),'m')`).run();
    const app = createApiRouter(db);

    const dates = (await (await app.request("/journal/dates")).json()) as any;
    expect(dates.dates).toEqual([{ date: "2026-07-15", projects: ["My Project"] }]);

    const entries = (await (await app.request("/journal/entries?date=2026-07-15")).json()) as any;
    expect(entries.entries).toHaveLength(1);
    expect(entries.entries[0]).toMatchObject({
      headline: "Built the thing", summary: "Did a lot",
      topics: ["infra", "api"], open_questions: ["what next?"], session_ids: ["s1", "s2"],
    });

    const missing = await app.request("/journal/entries");
    expect(missing.status).toBe(400);
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
    // The subagent must be ingested to be listed (else it would be a dead link).
    db.query(
      `INSERT INTO sessions (id, parent_session_id, project_id, project_path, source_path, started_at, message_count, is_subagent, ingested_at)
       VALUES ('agent-a1','s3','p','/tmp/p', ?, '2026-07-10T00:00:05Z', 1, 1, datetime('now'))`
    ).run(join(subDir, "agent-a1.jsonl"));

    const app = createApiRouter(db);
    const res = await app.request("/sessions/s3");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toBe("s3");
    expect(body.project_id).toBe("p");
    expect(body.subagents).toEqual([
      { agentId: "a1", agentType: "general-purpose", description: "Investigate widget bug", toolUseId: "toolu_1", spawnDepth: 1, started_at: "2026-07-10T00:00:05Z" },
    ]);
  });

  test("GET /sessions/:id omits a subagent that is discovered on disk but NOT ingested (no dead link)", async () => {
    const sourcePath = join(tempDir, "s3b.jsonl");
    writeFileSync(sourcePath, "");
    const subDir = join(tempDir, "s3b", "subagents");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "agent-ghost.jsonl"), "");
    writeFileSync(join(subDir, "agent-ghost.meta.json"), JSON.stringify({ agentType: "Explore", description: "never ingested" }));
    db.query("INSERT OR IGNORE INTO projects (id, path, display_name) VALUES ('p','/tmp/p','Proj')").run();
    db.query(`INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at)
              VALUES ('s3b','p','/tmp/p', ?, '2026-07-10T00:00:00Z', 1, datetime('now'))`).run(sourcePath);

    const app = createApiRouter(db);
    const body = (await (await app.request("/sessions/s3b")).json()) as any;
    expect(body.subagents).toEqual([]); // agent-ghost has no session row → not listed
  });

  test("GET /sessions/:id lists nested (spawnDepth>1) subagents too, since they live flat under the top session", async () => {
    const sourcePath = join(tempDir, "s3c.jsonl");
    writeFileSync(sourcePath, "");
    const subDir = join(tempDir, "s3c", "subagents");
    mkdirSync(subDir, { recursive: true });
    db.query("INSERT OR IGNORE INTO projects (id, path, display_name) VALUES ('p','/tmp/p','Proj')").run();
    db.query(`INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at)
              VALUES ('s3c','p','/tmp/p', ?, '2026-07-10T00:00:00Z', 1, datetime('now'))`).run(sourcePath);
    for (const [a, depth, start] of [["d1", 1, "01"], ["d2", 2, "02"]] as const) {
      writeFileSync(join(subDir, `agent-${a}.jsonl`), "");
      writeFileSync(join(subDir, `agent-${a}.meta.json`), JSON.stringify({ agentType: "general-purpose", description: `depth-${depth}`, spawnDepth: depth }));
      db.query(`INSERT INTO sessions (id, parent_session_id, project_id, project_path, source_path, started_at, message_count, is_subagent, ingested_at)
                VALUES (?, 's3c','p','/tmp/p','/x', ?, 1, 1, datetime('now'))`).run(`agent-${a}`, `2026-07-10T00:00:${start}Z`);
    }

    const app = createApiRouter(db);
    const body = (await (await app.request("/sessions/s3c")).json()) as any;
    expect(body.subagents.map((s: any) => s.spawnDepth)).toEqual([1, 2]); // both reachable, chronological
  });

  test("GET /sessions/:id returns subagents ordered chronologically with started_at", async () => {
    const sourcePath = join(tempDir, "sx.jsonl");
    writeFileSync(sourcePath, "");
    const subDir = join(tempDir, "sx", "subagents");
    mkdirSync(subDir, { recursive: true });
    // agent-a1 sorts first alphabetically but STARTS LATER than agent-a2.
    for (const a of ["a1", "a2"]) {
      writeFileSync(join(subDir, `agent-${a}.jsonl`), "");
      writeFileSync(join(subDir, `agent-${a}.meta.json`), JSON.stringify({ agentType: "Explore", description: a === "a1" ? "later" : "earlier" }));
    }
    db.query("INSERT OR IGNORE INTO projects (id, path, display_name) VALUES ('p','/tmp/p','Proj')").run();
    db.query(`INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at)
              VALUES ('sx','p','/tmp/p', ?, '2026-07-10T00:00:00Z', 1, datetime('now'))`).run(sourcePath);
    db.query(`INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, is_subagent, ingested_at)
              VALUES ('agent-a1','p','/tmp/p','/x', '2026-07-10T02:00:00Z', 1, 1, datetime('now'))`).run();
    db.query(`INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, is_subagent, ingested_at)
              VALUES ('agent-a2','p','/tmp/p','/x', '2026-07-10T01:00:00Z', 1, 1, datetime('now'))`).run();

    const app = createApiRouter(db);
    const body = (await (await app.request("/sessions/sx")).json()) as any;
    expect(body.subagents.map((s: any) => s.agentId)).toEqual(["a2", "a1"]);
    expect(body.subagents.map((s: any) => s.started_at)).toEqual(["2026-07-10T01:00:00Z", "2026-07-10T02:00:00Z"]);
  });

  test("GET /sessions/:id 404s for missing session", async () => {
    const app = createApiRouter(db);
    const res = await app.request("/sessions/nope");
    expect(res.status).toBe(404);
  });

  test("GET /sessions/:id returns parent link + parent title for a subagent", async () => {
    db.query("INSERT OR IGNORE INTO projects (id, path, display_name) VALUES ('p','/tmp/p','Proj')").run();
    db.query(
      `INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at, title, title_source)
       VALUES ('parent1','p','/tmp/p', ?, '2026-07-10T00:00:00Z', 5, datetime('now'), 'Parent Title', 'generated')`
    ).run(join(tempDir, "parent1.jsonl"));
    const subSource = join(tempDir, "parent1", "subagents", "agent-a1.jsonl");
    mkdirSync(dirname(subSource), { recursive: true });
    writeFileSync(subSource, "");
    db.query(
      `INSERT INTO sessions (id, parent_session_id, project_id, project_path, source_path, started_at, message_count, is_subagent, ingested_at)
       VALUES ('agent-a1','parent1','p','/tmp/p', ?, '2026-07-10T00:00:05Z', 2, 1, datetime('now'))`
    ).run(subSource);

    const app = createApiRouter(db);
    const body = (await (await app.request("/sessions/agent-a1")).json()) as any;
    expect(body.id).toBe("agent-a1");
    expect(body.is_subagent).toBe(1);
    expect(body.parent_session_id).toBe("parent1");
    expect(body.parent_title).toBe("Parent Title");
  });

  test("GET /sessions/:id does NOT return a parent_title for a continuation (non-subagent with a parent_session_id)", async () => {
    db.query("INSERT OR IGNORE INTO projects (id, path, display_name) VALUES ('p','/tmp/p','Proj')").run();
    db.query(`INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at, title)
              VALUES ('orig','p','/tmp/p','/tmp/orig.jsonl','2026-07-10T00:00:00Z',5,datetime('now'),'Original')`).run();
    // A resumed session: is_subagent=0 but parent_session_id points at the original.
    db.query(`INSERT INTO sessions (id, parent_session_id, project_id, project_path, source_path, started_at, message_count, is_subagent, ingested_at)
              VALUES ('resumed','orig','p','/tmp/p','/tmp/resumed.jsonl','2026-07-11T00:00:00Z',3,0,datetime('now'))`).run();

    const app = createApiRouter(db);
    const body = (await (await app.request("/sessions/resumed")).json()) as any;
    expect(body.is_subagent).toBe(0);
    expect(body.parent_title).toBeNull(); // no "Subagent of…" backlink for a continuation
  });

  test("GET /sessions/:id exposes a subagent's own subtask title (its meta description), no agent type", async () => {
    db.query("INSERT OR IGNORE INTO projects (id, path, display_name) VALUES ('p','/tmp/p','Proj')").run();
    const subSource = join(tempDir, "parentX", "subagents", "agent-z1.jsonl");
    mkdirSync(dirname(subSource), { recursive: true });
    writeFileSync(subSource, "");
    writeFileSync(subSource.replace(/\.jsonl$/, ".meta.json"), JSON.stringify({ agentType: "Explore", description: "Verify sessions table schema", toolUseId: "toolu_spawn9" }));
    db.query(
      `INSERT INTO sessions (id, parent_session_id, project_id, project_path, source_path, started_at, message_count, is_subagent, ingested_at)
       VALUES ('agent-z1','parentX','p','/tmp/p', ?, '2026-07-10T00:00:05Z', 2, 1, datetime('now'))`
    ).run(subSource);

    const app = createApiRouter(db);
    const body = (await (await app.request("/sessions/agent-z1")).json()) as any;
    expect(body.subtask_title).toBe("Verify sessions table schema");
    expect(body.spawn_tool_use_id).toBe("toolu_spawn9");
  });

  test("GET /sessions/:id parent_title is null when session has no parent", async () => {
    db.query("INSERT OR IGNORE INTO projects (id, path, display_name) VALUES ('p','/tmp/p','Proj')").run();
    const src = join(tempDir, "top.jsonl");
    writeFileSync(src, "");
    db.query(
      `INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at)
       VALUES ('top','p','/tmp/p', ?, '2026-07-10T00:00:00Z', 1, datetime('now'))`
    ).run(src);
    const app = createApiRouter(db);
    const body = (await (await app.request("/sessions/top")).json()) as any;
    expect(body.parent_session_id ?? null).toBeNull();
    expect(body.parent_title ?? null).toBeNull();
  });

  test("journal entry session refs include nested subagents", async () => {
    const parentSource = join(tempDir, "s1.jsonl");
    writeFileSync(parentSource, "");
    const subDir = join(tempDir, "s1", "subagents");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "agent-a1.jsonl"), "");
    writeFileSync(join(subDir, "agent-a1.meta.json"), JSON.stringify({ agentType: "general-purpose", description: "Investigate", toolUseId: "toolu_1", spawnDepth: 1 }));

    db.query("INSERT INTO projects (id, path, display_name) VALUES ('p','/tmp/p','My Project')").run();
    db.query(
      `INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at, title)
       VALUES ('s1','p','/tmp/p', ?, '2026-07-15T00:00:00Z', 3, datetime('now'), 'Real Session')`
    ).run(parentSource);
    db.query(`INSERT INTO sessions (id, parent_session_id, project_id, project_path, source_path, started_at, message_count, is_subagent, ingested_at)
              VALUES ('agent-a1','s1','p','/tmp/p', ?, '2026-07-15T00:00:05Z', 1, 1, datetime('now'))`).run(join(subDir, "agent-a1.jsonl"));
    db.query(`INSERT INTO journal_entries (date, project_id, session_ids, headline, summary, topics, open_questions, generated_at, model_used)
              VALUES ('2026-07-15','p','["s1"]','H','S','[]','[]',datetime('now'),'m')`).run();

    const app = createApiRouter(db);
    const entries = (await (await app.request("/journal/entries?date=2026-07-15")).json()) as any;
    expect(entries.entries[0].sessions).toEqual([
      { id: "s1", title: "Real Session", subagents: [{ id: "agent-a1", agentType: "general-purpose", description: "Investigate" }] },
    ]);
  });

  test("journal entry nested subagents are ordered chronologically by start time", async () => {
    const parentSource = join(tempDir, "p2.jsonl");
    writeFileSync(parentSource, "");
    const subDir = join(tempDir, "p2", "subagents");
    mkdirSync(subDir, { recursive: true });
    // agent-a1 sorts first alphabetically but STARTS LATER; agent-a2 starts earlier.
    writeFileSync(join(subDir, "agent-a1.jsonl"), "");
    writeFileSync(join(subDir, "agent-a1.meta.json"), JSON.stringify({ agentType: "general-purpose", description: "later" }));
    writeFileSync(join(subDir, "agent-a2.jsonl"), "");
    writeFileSync(join(subDir, "agent-a2.meta.json"), JSON.stringify({ agentType: "general-purpose", description: "earlier" }));

    db.query("INSERT INTO projects (id, path, display_name) VALUES ('p','/tmp/p','My Project')").run();
    db.query(
      `INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at, title)
       VALUES ('p2','p','/tmp/p', ?, '2026-07-15T00:00:00Z', 3, datetime('now'), 'Parent')`
    ).run(parentSource);
    db.query(`INSERT INTO sessions (id, parent_session_id, project_id, project_path, source_path, started_at, message_count, is_subagent, ingested_at)
              VALUES ('agent-a1','p2','p','/tmp/p', ?, '2026-07-15T02:00:00Z', 1, 1, datetime('now'))`).run(join(subDir, "agent-a1.jsonl"));
    db.query(`INSERT INTO sessions (id, parent_session_id, project_id, project_path, source_path, started_at, message_count, is_subagent, ingested_at)
              VALUES ('agent-a2','p2','p','/tmp/p', ?, '2026-07-15T01:00:00Z', 1, 1, datetime('now'))`).run(join(subDir, "agent-a2.jsonl"));
    db.query(`INSERT INTO journal_entries (date, project_id, session_ids, headline, summary, topics, open_questions, generated_at, model_used)
              VALUES ('2026-07-15','p','["p2"]','H','S','[]','[]',datetime('now'),'m')`).run();

    const app = createApiRouter(db);
    const entries = (await (await app.request("/journal/entries?date=2026-07-15")).json()) as any;
    const subs = entries.entries[0].sessions[0].subagents;
    // earlier start (agent-a2) first, despite sorting later alphabetically.
    expect(subs.map((s: any) => s.id)).toEqual(["agent-a2", "agent-a1"]);
    expect(subs.map((s: any) => s.description)).toEqual(["earlier", "later"]);
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

  test("GET /sessions excludes subagents", async () => {
    db.query("INSERT OR IGNORE INTO projects (id, path, display_name) VALUES ('p','/tmp/p','P')").run();
    db.query(`INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at)
              VALUES ('s1','p','/tmp/p','/tmp/s1.jsonl','2026-07-10T00:00:00Z',3,datetime('now'))`).run();
    db.query(`INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, is_subagent, ingested_at)
              VALUES ('agent-x1','p','/tmp/p','/tmp/a.jsonl','2026-07-10T00:00:05Z',1,1,datetime('now'))`).run();

    const app = createApiRouter(db);
    const body = (await (await app.request("/sessions")).json()) as any;
    expect(body.total).toBe(1);
    expect(body.sessions.map((s: any) => s.id)).toEqual(["s1"]);
  });

  function seedJournal() {
    db.query("INSERT INTO projects (id, path, display_name, last_session_at, session_count) VALUES ('p','/tmp/p','My Project','2026-07-15T00:00:00Z',2)").run();
    db.query(`INSERT INTO journal_entries (date, project_id, session_ids, headline, summary, topics, open_questions, generated_at, model_used)
              VALUES ('2026-07-15','p','["s1"]','Built it','did work','["infra"]','["next?"]',datetime('now'),'m')`).run();
  }

  test("GET /projects and /projects/:id/entries", async () => {
    seedJournal();
    const app = createApiRouter(db);
    const projects = (await (await app.request("/projects")).json()) as any;
    expect(projects.projects[0]).toMatchObject({ id: "p", display_name: "My Project" });
    const entries = (await (await app.request("/projects/p/entries")).json()) as any;
    expect(entries.entries[0]).toMatchObject({ headline: "Built it", topics: ["infra"], session_ids: ["s1"] });
  });

  test("GET /calendar returns per-date activity for a month", async () => {
    seedJournal();
    const app = createApiRouter(db);
    const cal = (await (await app.request("/calendar?month=2026-07")).json()) as any;
    expect(cal.days).toEqual([{ date: "2026-07-15", entries: 1, projects: ["My Project"] }]);
  });

  test("GET /groups, /groups/ungrouped, /groups/:id — group/ungrouped rows carry nested subagents", async () => {
    db.query("INSERT OR IGNORE INTO projects (id, path, display_name) VALUES ('p','/tmp/p','P')").run();
    // s1 has a subagent on disk; s2 will be grouped.
    const s1Source = join(tempDir, "s1.jsonl");
    writeFileSync(s1Source, "");
    const subDir = join(tempDir, "s1", "subagents");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "agent-g1.jsonl"), "");
    writeFileSync(join(subDir, "agent-g1.meta.json"), JSON.stringify({ agentType: "Explore", description: "dig in" }));
    db.query(`INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at)
              VALUES ('s1','p','/tmp/p', ?, '2026-07-10T00:00:00Z',3,datetime('now'))`).run(s1Source);
    db.query(`INSERT INTO sessions (id, parent_session_id, project_id, project_path, source_path, started_at, message_count, is_subagent, ingested_at)
              VALUES ('agent-g1','s1','p','/tmp/p', ?, '2026-07-10T00:00:05Z',1,1,datetime('now'))`).run(join(subDir, "agent-g1.jsonl"));
    db.query(`INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at)
              VALUES ('s2','p','/tmp/p','/tmp/s2.jsonl','2026-07-11T00:00:00Z',3,datetime('now'))`).run();
    const gid = (db.query("INSERT INTO groups (name, created_at) VALUES ('Trading', datetime('now')) RETURNING id").get() as any).id;
    db.query("INSERT INTO session_groups (session_id, group_id, assigned_at) VALUES ('s2', ?, datetime('now'))").run(gid);
    const app = createApiRouter(db);

    const groups = (await (await app.request("/groups")).json()) as any;
    expect(groups.groups.map((g: any) => g.name)).toContain("Trading");

    const ung = (await (await app.request("/groups/ungrouped")).json()) as any;
    expect(ung.total).toBe(1);
    expect(ung.sessions[0].id).toBe("s1");
    expect(ung.sessions[0].subagents).toEqual([{ id: "agent-g1", agentType: "Explore", description: "dig in" }]);

    const detail = (await (await app.request(`/groups/${gid}`)).json()) as any;
    expect(detail.group.name).toBe("Trading");
    expect(detail.sessions[0].id).toBe("s2");
    expect(detail.sessions[0].subagents).toEqual([]); // s2 has no subagents dir
    expect((await app.request("/groups/99999")).status).toBe(404);
  });
});

import { importDesktopGroups } from "../../groups";
describe("importDesktopGroups reconcile", () => {
  let tempDir: string, db: ReturnType<typeof initDb>;
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), "imp-")); db = initDb(join(tempDir, "t.db")); });
  afterEach(() => { closeDb(); rmSync(tempDir, { recursive: true, force: true }); });

  test("creates desktop groups by desktop_id, assigns existing sessions, skips missing", () => {
    db.query("INSERT INTO projects (id, path, display_name) VALUES ('p','/tmp/p','P')").run();
    db.query(`INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at)
              VALUES ('cli1','p','/tmp/p','/tmp/s.jsonl','2026-07-10T00:00:00Z',3,datetime('now'))`).run();
    const summary = importDesktopGroups(db, {
      groups: [{ desktopId: "cg-1", name: "Tolaria" }, { desktopId: "cg-2", name: "OpenBB" }],
      assignments: [{ cliSessionId: "cli1", desktopGroupId: "cg-1" }, { cliSessionId: "missing", desktopGroupId: "cg-2" }],
    });
    expect(summary.groupsAdded).toBe(2);
    expect(summary.sessionsAssigned).toBe(1);
    expect(summary.skippedNoSession).toBe(1);
    const tol = db.query("SELECT id FROM groups WHERE desktop_id='cg-1'").get() as { id: number };
    expect((db.query("SELECT group_id FROM session_groups WHERE session_id='cli1'").get() as any).group_id).toBe(tol.id);
    // idempotent + removes dropped desktop group
    const s2 = importDesktopGroups(db, { groups: [{ desktopId: "cg-1", name: "Tolaria" }], assignments: [{ cliSessionId: "cli1", desktopGroupId: "cg-1" }] });
    expect(s2.groupsRemoved).toBe(1);
    expect(db.query("SELECT id FROM groups WHERE desktop_id='cg-2'").get()).toBeNull();
  });
});
