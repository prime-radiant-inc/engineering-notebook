import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { scanSources, ingestSessions } from "./ingest";
import { initDb, closeDb } from "./db";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, copyFileSync } from "fs";
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
    expect(second.ingested).toBe(1);
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

  test("ingests a Cursor session file into the database", () => {
    const uuid = "11111111-1111-4111-8111-111111111111";
    const fixturePath = join(
      import.meta.dir,
      `../tests/fixtures/cursor/Users-test-GitRepos-demo-app/agent-transcripts/${uuid}/${uuid}.jsonl`
    );
    const dir = join(tempDir, "Users-test-GitRepos-demo-app", "agent-transcripts", uuid);
    mkdirSync(dir, { recursive: true });
    const sessionFile = join(dir, `${uuid}.jsonl`);
    copyFileSync(fixturePath, sessionFile);

    const result = ingestSessions([sessionFile], db);
    expect(result.ingested).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors.length).toBe(0);

    const session = db
      .query("SELECT id, project_id, message_count, is_subagent FROM sessions")
      .get() as {
      id: string;
      project_id: string;
      message_count: number;
      is_subagent: number;
    } | null;
    expect(session?.id).toBe(uuid);
    expect(session?.project_id).toBe("Users-test-GitRepos-demo-app");
    expect(session?.message_count).toBe(3);
    expect(session?.is_subagent).toBe(0);
  });
});
