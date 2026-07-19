import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../../db";
import { createGroup, assignSession } from "../../groups";
import { renderGroupsIndex, renderGroupDetail } from "./groups";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("groups views", () => {
  let tempDir: string;
  let db: ReturnType<typeof initDb>;

  function seed(sessionId: string) {
    db.query("INSERT OR IGNORE INTO projects (id, path, display_name) VALUES ('p','/tmp/p','My Project')").run();
    db.query(
      `INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at)
       VALUES (?, 'p', '/tmp/p', '/tmp/s.jsonl', '2026-07-10T00:00:00Z', 3, datetime('now'))`
    ).run(sessionId);
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "notebook-groupsview-test-"));
    db = initDb(join(tempDir, "test.db"));
  });
  afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("index shows create form and existing groups", () => {
    createGroup(db, "Trading");
    const html = renderGroupsIndex(db);
    expect(html).toContain('action="/groups"');
    expect(html).toContain("Trading");
    expect(html).toContain('href="/groups/');
  });

  test("index escapes group names", () => {
    createGroup(db, "<x>");
    const html = renderGroupsIndex(db);
    expect(html).toContain("&lt;x&gt;");
    expect(html).not.toContain("<x>");
  });

  test("index shows an error banner when provided", () => {
    const html = renderGroupsIndex(db, "Group name already exists");
    expect(html).toContain("Group name already exists");
  });

  test("detail lists member sessions with links", () => {
    seed("s1");
    const gid = createGroup(db, "Trading");
    assignSession(db, "s1", gid);
    const html = renderGroupDetail(db, gid)!;
    expect(html).toContain("Trading");
    expect(html).toContain("My Project");
    expect(html).toContain('href="/session/s1"');
    expect(html).toContain('action="/groups/' + gid + '/rename"');
    expect(html).toContain('action="/groups/' + gid + '/delete"');
  });

  test("detail returns null for missing group", () => {
    expect(renderGroupDetail(db, 12345)).toBeNull();
  });

  test("detail shows empty-state for a group with no sessions", () => {
    const gid = createGroup(db, "Empty");
    const html = renderGroupDetail(db, gid)!;
    expect(html).toContain("empty-state");
  });
});
