import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "./db";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  createGroup, listGroups, renameGroup, deleteGroup,
  assignSession, getSessionGroupId, getGroupWithSessions,
} from "./groups";

describe("groups", () => {
  let tempDir: string;
  let db: ReturnType<typeof initDb>;

  function seedProject(id = "proj-a") {
    db.query(
      "INSERT INTO projects (id, path, display_name) VALUES (?, ?, ?)"
    ).run(id, "/tmp/" + id, id);
  }
  function seedSession(id: string, projectId = "proj-a", startedAt = "2026-07-10T12:00:00Z") {
    db.query(
      `INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    ).run(id, projectId, "/tmp/" + projectId, "/tmp/src.jsonl", startedAt, 5);
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "notebook-groups-test-"));
    db = initDb(join(tempDir, "test.db"));
  });
  afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("createGroup then listGroups shows it with zero sessions", () => {
    const id = createGroup(db, "Trading");
    const groups = listGroups(db);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.id).toBe(id);
    expect(groups[0]!.name).toBe("Trading");
    expect(groups[0]!.sessionCount).toBe(0);
    expect(groups[0]!.lastActivityAt).toBeNull();
  });

  test("createGroup rejects empty and duplicate names", () => {
    createGroup(db, "Trading");
    expect(() => createGroup(db, "   ")).toThrow("Group name required");
    expect(() => createGroup(db, "Trading")).toThrow("Group name already exists");
  });

  test("assignSession files a session and updates count + lastActivity", () => {
    seedProject();
    seedSession("s1", "proj-a", "2026-07-11T09:00:00Z");
    const gid = createGroup(db, "Trading");
    assignSession(db, "s1", gid);
    expect(getSessionGroupId(db, "s1")).toBe(gid);
    const g = listGroups(db)[0]!;
    expect(g.sessionCount).toBe(1);
    expect(g.lastActivityAt).toBe("2026-07-11T09:00:00Z");
    const detail = getGroupWithSessions(db, gid)!;
    expect(detail.sessions.map((s) => s.id)).toEqual(["s1"]);
  });

  test("assignSession reassigns (one group per session)", () => {
    seedProject();
    seedSession("s1");
    const g1 = createGroup(db, "A");
    const g2 = createGroup(db, "B");
    assignSession(db, "s1", g1);
    assignSession(db, "s1", g2);
    expect(getSessionGroupId(db, "s1")).toBe(g2);
    expect(getGroupWithSessions(db, g1)!.sessions).toHaveLength(0);
    expect(getGroupWithSessions(db, g2)!.sessions).toHaveLength(1);
  });

  test("assignSession null unassigns", () => {
    seedProject();
    seedSession("s1");
    const gid = createGroup(db, "A");
    assignSession(db, "s1", gid);
    assignSession(db, "s1", null);
    expect(getSessionGroupId(db, "s1")).toBeNull();
  });

  test("renameGroup rejects duplicate name", () => {
    createGroup(db, "A");
    const b = createGroup(db, "B");
    expect(() => renameGroup(db, b, "A")).toThrow("Group name already exists");
    renameGroup(db, b, "B2");
    expect(listGroups(db).find((g) => g.id === b)!.name).toBe("B2");
  });

  test("deleteGroup removes group and its memberships (cascade)", () => {
    seedProject();
    seedSession("s1");
    const gid = createGroup(db, "A");
    assignSession(db, "s1", gid);
    deleteGroup(db, gid);
    expect(listGroups(db)).toHaveLength(0);
    expect(getSessionGroupId(db, "s1")).toBeNull();
  });

  test("membership survives session delete + re-insert (re-ingest)", () => {
    seedProject();
    seedSession("s1");
    const gid = createGroup(db, "A");
    assignSession(db, "s1", gid);
    // Simulate --force re-ingest: delete then re-insert same id
    db.query("DELETE FROM sessions WHERE id = ?").run("s1");
    seedSession("s1");
    expect(getSessionGroupId(db, "s1")).toBe(gid);
    expect(getGroupWithSessions(db, gid)!.sessions).toHaveLength(1);
  });

  test("orphan membership (deleted, not re-inserted) is filtered from detail", () => {
    seedProject();
    seedSession("s1");
    const gid = createGroup(db, "A");
    assignSession(db, "s1", gid);
    db.query("DELETE FROM sessions WHERE id = ?").run("s1");
    expect(getGroupWithSessions(db, gid)!.sessions).toHaveLength(0);
    expect(listGroups(db)[0]!.sessionCount).toBe(0);
  });

  test("getGroupWithSessions returns null for missing group", () => {
    expect(getGroupWithSessions(db, 999)).toBeNull();
  });
});
