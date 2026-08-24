import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { cacheDir, buildRsyncCommand, SyncManager } from "./sync";
import { initDb, closeDb } from "./db";
import { defaultConfig } from "./config";
import { mkdtempSync, rmSync, mkdirSync, copyFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

describe("sync", () => {
  describe("cacheDir", () => {
    const base = join(homedir(), ".config", "engineering-notebook", "remotes");

    test("sanitizes name to safe directory", () => {
      expect(cacheDir("Work MacBook")).toBe(join(base, "work-macbook"));
    });

    test("handles spaces and special characters", () => {
      expect(cacheDir("My Remote!@#Server")).toBe(
        join(base, "my-remote-server")
      );
    });

    test("collapses multiple dashes", () => {
      expect(cacheDir("a---b")).toBe(join(base, "a-b"));
    });

    test("strips leading and trailing dashes", () => {
      expect(cacheDir("--name--")).toBe(join(base, "name"));
    });

    test("falls back to 'unnamed' for empty result", () => {
      expect(cacheDir("!!!")).toBe(join(base, "unnamed"));
    });
  });

  describe("buildRsyncCommand", () => {
    test("produces correct rsync invocation", () => {
      const source = {
        name: "Test",
        host: "jesse@macbook.local",
        path: "~/.claude/projects",
        enabled: true,
      };
      const cmd = buildRsyncCommand(source, "/tmp/cache");
      expect(cmd).toEqual([
        "rsync",
        "-az",
        "--delete",
        "-e",
        "ssh -o BatchMode=yes -o ConnectTimeout=10",
        "jesse@macbook.local:~/.claude/projects/",
        "/tmp/cache/",
      ]);
    });

    test("uses BatchMode and ConnectTimeout", () => {
      const source = {
        name: "X",
        host: "user@host",
        path: "/data",
        enabled: true,
      };
      const cmd = buildRsyncCommand(source, "/dest");
      const sshFlag = cmd[cmd.indexOf("-e") + 1];
      expect(sshFlag).toContain("BatchMode=yes");
      expect(sshFlag).toContain("ConnectTimeout=10");
    });
  });

  describe("SyncManager.runSync", () => {
    let tempDir: string;
    let db: ReturnType<typeof initDb>;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "notebook-sync-test-"));
      db = initDb(join(tempDir, "test.db"));
      const projectDir = join(tempDir, "sources", "-Users-test-myapp");
      mkdirSync(projectDir, { recursive: true });
      copyFileSync(
        join(import.meta.dir, "../tests/fixtures/test-session-1.jsonl"),
        join(projectDir, "test-session-1.jsonl")
      );
    });

    afterEach(() => {
      closeDb();
      rmSync(tempDir, { recursive: true, force: true });
    });

    test("ingests local sources when no remote sources are configured", async () => {
      const config = {
        ...defaultConfig(),
        sources: [join(tempDir, "sources")],
        exclude: [],
        remote_sources: [],
      };

      await new SyncManager(config, db).runSync();

      const sessions = db.query("SELECT * FROM sessions").all();
      expect(sessions.length).toBe(1);
    });

    test("reports ingest stats when no remote sources are configured", async () => {
      const config = {
        ...defaultConfig(),
        sources: [join(tempDir, "sources")],
        exclude: [],
        remote_sources: [],
      };

      const manager = new SyncManager(config, db);
      await manager.runSync();

      expect(manager.getStatus().lastIngestStats).toEqual({
        ingested: 1,
        skipped: 0,
        errors: 0,
      });
    });
  });
});
