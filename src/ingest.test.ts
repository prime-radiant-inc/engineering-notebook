import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { scanSources, ingestSessions } from "./ingest";
import { initDb, closeDb } from "./db";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, copyFileSync, appendFileSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";


describe("scanSources", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "notebook-ingest-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("finds .jsonl files in project directories", () => {
    const projectDir = join(tempDir, "-Users-test-project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "session-1.jsonl"), "{}");
    writeFileSync(join(projectDir, "session-2.jsonl"), "{}");
    writeFileSync(join(projectDir, "memory"), "{}");

    const files = scanSources([tempDir], []);
    expect(files.length).toBe(2);
  });

  test("excludes matching patterns", () => {
    const included = join(tempDir, "-Users-test-myapp");
    const excluded = join(tempDir, "-private-tmp");
    mkdirSync(included, { recursive: true });
    mkdirSync(excluded, { recursive: true });
    writeFileSync(join(included, "s1.jsonl"), "{}");
    writeFileSync(join(excluded, "s2.jsonl"), "{}");

    const files = scanSources([tempDir], ["-private-tmp*"]);
    expect(files.length).toBe(1);
    expect(files[0]).toContain("myapp");
  });

  test("finds .jsonl files in nested directories", () => {
    const nested = join(tempDir, "2026", "02", "24");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "rollout-1.jsonl"), "{}");

    const files = scanSources([tempDir], []);
    expect(files.length).toBe(1);
    expect(files[0]).toContain("rollout-1.jsonl");
  });
});

describe("ingestSessions", () => {
  let tempDir: string;
  let db: ReturnType<typeof initDb>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "notebook-ingest-test-"));
    db = initDb(join(tempDir, "test.db"));
  });

  afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("ingests a session file into the database", () => {
    const fixturePath = join(import.meta.dir, "../tests/fixtures/test-session-1.jsonl");
    const projectDir = join(tempDir, "-Users-test-myapp");
    mkdirSync(projectDir, { recursive: true });
    const sessionFile = join(projectDir, "test-session-1.jsonl");
    copyFileSync(fixturePath, sessionFile);

    const result = ingestSessions([sessionFile], db);
    expect(result.ingested).toBe(1);
    expect(result.skipped).toBe(0);

    const sessions = db.query("SELECT * FROM sessions").all();
    expect(sessions.length).toBe(1);

    const convos = db.query("SELECT * FROM conversations").all();
    expect(convos.length).toBe(1);

    const projects = db.query("SELECT * FROM projects").all();
    expect(projects.length).toBe(1);
  });

  test("skips already-ingested sessions", () => {
    const fixturePath = join(import.meta.dir, "../tests/fixtures/test-session-1.jsonl");
    const projectDir = join(tempDir, "-Users-test-myapp");
    mkdirSync(projectDir, { recursive: true });
    const sessionFile = join(projectDir, "test-session-1.jsonl");
    copyFileSync(fixturePath, sessionFile);

    ingestSessions([sessionFile], db);
    const result = ingestSessions([sessionFile], db);
    expect(result.ingested).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test("re-ingests sessions when force=true", () => {
    const fixturePath = join(import.meta.dir, "../tests/fixtures/test-session-1.jsonl");
    const projectDir = join(tempDir, "-Users-test-myapp");
    mkdirSync(projectDir, { recursive: true });
    const sessionFile = join(projectDir, "test-session-1.jsonl");
    copyFileSync(fixturePath, sessionFile);

    const first = ingestSessions([sessionFile], db);
    expect(first.ingested).toBe(1);
    expect(first.errors.length).toBe(0);

    const second = ingestSessions([sessionFile], db, true);
    expect(second.ingested).toBe(0);
    expect(second.reingested).toBe(1);
    expect(second.skipped).toBe(0);
    expect(second.errors.length).toBe(0);

    const sessions = db.query("SELECT * FROM sessions").all();
    expect(sessions.length).toBe(1);

    const convos = db.query("SELECT * FROM conversations").all();
    expect(convos.length).toBe(1);
  });

  test("marks sessions in /subagents/ paths as is_subagent=1", () => {
    const fixturePath = join(import.meta.dir, "../tests/fixtures/test-session-1.jsonl");
    const subagentDir = join(tempDir, "-Users-test-myapp", "subagents");
    mkdirSync(subagentDir, { recursive: true });
    const sessionFile = join(subagentDir, "test-session-1.jsonl");
    copyFileSync(fixturePath, sessionFile);

    ingestSessions([sessionFile], db);
    const session = db.query("SELECT is_subagent FROM sessions").get() as { is_subagent: number } | null;
    expect(session?.is_subagent).toBe(1);
  });

  test("marks regular sessions as is_subagent=0", () => {
    const fixturePath = join(import.meta.dir, "../tests/fixtures/test-session-1.jsonl");
    const projectDir = join(tempDir, "-Users-test-myapp");
    mkdirSync(projectDir, { recursive: true });
    const sessionFile = join(projectDir, "test-session-1.jsonl");
    copyFileSync(fixturePath, sessionFile);

    ingestSessions([sessionFile], db);
    const session = db.query("SELECT is_subagent FROM sessions").get() as { is_subagent: number } | null;
    expect(session?.is_subagent).toBe(0);
  });

  test("ingests a Codex session file into the database", () => {
    const fixturePath = join(import.meta.dir, "../tests/fixtures/test-codex-session-1.jsonl");
    const codexDir = join(tempDir, "2026", "02", "24");
    mkdirSync(codexDir, { recursive: true });
    const sessionFile = join(codexDir, "rollout-2026-02-24T09-00-00-019bf429-646d-70c2-a8b8-a0d69db3f01d.jsonl");
    copyFileSync(fixturePath, sessionFile);

    const result = ingestSessions([sessionFile], db);
    expect(result.ingested).toBe(1);
    expect(result.errors.length).toBe(0);

    const session = db.query("SELECT id, project_path, version, message_count FROM sessions").get() as {
      id: string;
      project_path: string;
      version: string;
      message_count: number;
    } | null;
    expect(session).toBeTruthy();
    expect(session?.id).toBe("019bf429-646d-70c2-a8b8-a0d69db3f01d");
    expect(session?.project_path).toBe("/Users/peteror/Code/engineering-notebook");
    expect(session?.version).toBe("0.99.0-alpha.23");
    expect(session?.message_count).toBe(2);
  });

  test("re-ingests when source file has grown (claude/codex appends to existing session)", () => {
    const fixturePath = join(import.meta.dir, "../tests/fixtures/test-session-1.jsonl");
    const projectDir = join(tempDir, "-Users-test-myapp");
    mkdirSync(projectDir, { recursive: true });
    const sessionFile = join(projectDir, "test-session-1.jsonl");
    copyFileSync(fixturePath, sessionFile);

    const first = ingestSessions([sessionFile], db);
    expect(first.ingested).toBe(1);
    const firstSnapshot = db.query("SELECT source_size, source_mtime FROM sessions").get() as { source_size: number; source_mtime: string };
    expect(firstSnapshot.source_size).toBeGreaterThan(0);

    // Append to simulate Claude/Codex continuing the session
    const originalRaw = require("fs").readFileSync(fixturePath, "utf-8");
    appendFileSync(sessionFile, originalRaw); // doubles the content

    // Bump mtime to ensure detection even if the OS clock granularity coalesces the writes
    const future = new Date(Date.now() + 60_000);
    utimesSync(sessionFile, future, future);

    const second = ingestSessions([sessionFile], db);
    expect(second.ingested).toBe(0);
    expect(second.reingested).toBe(1);
    expect(second.skipped).toBe(0);

    const secondSnapshot = db.query("SELECT source_size FROM sessions").get() as { source_size: number };
    expect(secondSnapshot.source_size).toBeGreaterThan(firstSnapshot.source_size);
  });

  test("skips unchanged files on repeated ingest (size and mtime both match)", () => {
    const fixturePath = join(import.meta.dir, "../tests/fixtures/test-session-1.jsonl");
    const projectDir = join(tempDir, "-Users-test-myapp");
    mkdirSync(projectDir, { recursive: true });
    const sessionFile = join(projectDir, "test-session-1.jsonl");
    copyFileSync(fixturePath, sessionFile);

    ingestSessions([sessionFile], db);
    const result = ingestSessions([sessionFile], db);
    expect(result.ingested).toBe(0);
    expect(result.reingested).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test("re-ingesting invalidates journal entries for the affected (date, project)", () => {
    const fixturePath = join(import.meta.dir, "../tests/fixtures/test-session-1.jsonl");
    const projectDir = join(tempDir, "-Users-test-myapp");
    mkdirSync(projectDir, { recursive: true });
    const sessionFile = join(projectDir, "test-session-1.jsonl");
    copyFileSync(fixturePath, sessionFile);

    ingestSessions([sessionFile], db);
    const session = db.query("SELECT id, project_id, date(started_at) as date FROM sessions").get() as { id: string; project_id: string; date: string };

    // Plant a journal entry for that (date, project_id)
    db.exec(`
      INSERT INTO journal_entries (date, project_id, session_ids, headline, summary, generated_at, model_used)
      VALUES ('${session.date}', '${session.project_id}', '["${session.id}"]', 'cached', 'cached summary', datetime('now'), 'test')
    `);
    const beforeCount = (db.query("SELECT COUNT(*) as n FROM journal_entries").get() as { n: number }).n;
    expect(beforeCount).toBe(1);

    // Modify the file and re-ingest
    appendFileSync(sessionFile, require("fs").readFileSync(fixturePath, "utf-8"));
    utimesSync(sessionFile, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));

    const result = ingestSessions([sessionFile], db);
    expect(result.reingested).toBe(1);
    expect(result.invalidatedJournals).toBe(1);

    const afterCount = (db.query("SELECT COUNT(*) as n FROM journal_entries").get() as { n: number }).n;
    expect(afterCount).toBe(0);
  });
});
