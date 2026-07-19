import { describe, test, expect } from "bun:test";
import { renderSessionFooter } from "./session";
import { beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../../db";
import { createGroup, assignSession } from "../../groups";
import { renderSessionDetail } from "./session";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("renderSessionFooter", () => {
  test("renders Claude resume command for Claude session source paths", () => {
    const html = renderSessionFooter(
      "abc-session-id",
      "/Users/peteror/Code/engineering-notebook",
      "/Users/peteror/.claude/projects/myproj/abc-session-id.jsonl"
    );

    expect(html).toContain("claude --resume abc-session-id");
    expect(html).not.toContain("codex resume");
  });

  test("renders Codex resume command for Codex session source paths", () => {
    const html = renderSessionFooter(
      "019bf429-646d-70c2-a8b8-a0d69db3f01d",
      "/Users/peteror/Code/engineering-notebook",
      "/Users/peteror/.codex/sessions/2026/02/24/rollout-2026-02-24T09-00-00-019bf429-646d-70c2-a8b8-a0d69db3f01d.jsonl"
    );

    expect(html).toContain("codex resume 019bf429-646d-70c2-a8b8-a0d69db3f01d");
    expect(html).not.toContain("claude --resume");
  });
});

describe("session detail group control", () => {
  let tempDir: string;
  let db: ReturnType<typeof initDb>;

  function seed(id: string) {
    db.query("INSERT OR IGNORE INTO projects (id, path, display_name) VALUES ('p','/tmp/p','Proj')").run();
    db.query(
      `INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at)
       VALUES (?, 'p', '/tmp/p', '/tmp/s.jsonl', '2026-07-10T00:00:00Z', 3, datetime('now'))`
    ).run(id);
    db.query("INSERT INTO conversations (session_id, conversation_markdown, extracted_at) VALUES (?, '# hi', datetime('now'))").run(id);
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "notebook-sessionctl-test-"));
    db = initDb(join(tempDir, "test.db"));
  });
  afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("renders an assign form with a None option and each group", () => {
    seed("s1");
    createGroup(db, "Trading");
    createGroup(db, "Infra");
    const html = renderSessionDetail(db, "s1");
    expect(html).toContain('action="/sessions/s1/group"');
    expect(html).toContain("None");
    expect(html).toContain("Trading");
    expect(html).toContain("Infra");
  });

  test("preselects the session's current group", () => {
    seed("s1");
    const gid = createGroup(db, "Trading");
    assignSession(db, "s1", gid);
    const html = renderSessionDetail(db, "s1");
    expect(html).toMatch(new RegExp(`<option value="${gid}" selected`));
  });
});
