import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { initDb, closeDb } from "../db";
import {
  defaultConfig,
  loadConfig,
  saveConfig,
  resolveConfigPath,
} from "../config";
import { SyncManager } from "../sync";
import { createApp } from "./server";

describe("server", () => {
  let tempDir: string;
  let db: ReturnType<typeof initDb>;
  let syncManager: SyncManager;
  let originalConfigContent: string | null = null;
  const configPath = resolveConfigPath();

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "notebook-server-test-"));
    db = initDb(join(tempDir, "test.db"));

    // Backup real config before each test
    if (existsSync(configPath)) {
      originalConfigContent = readFileSync(configPath, "utf-8");
    } else {
      originalConfigContent = null;
    }

    const config = defaultConfig();
    saveConfig(configPath, config);
    syncManager = new SyncManager(config, db);
  });

  afterEach(() => {
    syncManager.stopTimer();
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });

    // Restore real config
    if (originalConfigContent !== null) {
      writeFileSync(configPath, originalConfigContent);
    }
  });

  /** Build a FormData with all required settings fields plus any extras */
  function settingsForm(
    extras: Record<string, string> = {}
  ): FormData {
    const form = new FormData();
    form.append("summary_instructions", "");
    form.append("day_start_hour", "5");
    form.append("sources", "~/.claude/projects");
    form.append("exclude", "-private-tmp*");
    form.append("port", "3000");
    form.append("auto_sync_interval", "60");
    for (const [k, v] of Object.entries(extras)) {
      form.append(k, v);
    }
    return form;
  }

  describe("POST /settings remote source parsing", () => {
    test("saves remote sources with non-sequential (timestamp) indices", async () => {
      const app = createApp(db, syncManager);

      const res = await app.request("/settings", {
        method: "POST",
        body: settingsForm({
          remote_name_1709000000000: "Work MacBook",
          remote_host_1709000000000: "jesse@macbook.local",
          remote_path_1709000000000: "~/.claude/projects",
          remote_enabled_1709000000000: "on",
          remote_name_1709000099999: "Home Desktop",
          remote_host_1709000099999: "jesse@desktop.local",
          remote_path_1709000099999: "/data/claude/projects",
          remote_enabled_1709000099999: "on",
        }),
      });

      expect(res.status).toBe(302);
      const saved = loadConfig(configPath);
      expect(saved.remote_sources).toHaveLength(2);
      expect(saved.remote_sources[0]!.name).toBe("Work MacBook");
      expect(saved.remote_sources[0]!.host).toBe("jesse@macbook.local");
      expect(saved.remote_sources[1]!.name).toBe("Home Desktop");
      expect(saved.remote_sources[1]!.path).toBe("/data/claude/projects");
    });

    test("saves remote sources with sequential indices", async () => {
      const app = createApp(db, syncManager);

      const res = await app.request("/settings", {
        method: "POST",
        body: settingsForm({
          remote_name_0: "Server A",
          remote_host_0: "user@server-a",
          remote_path_0: "~/.claude/projects",
          remote_enabled_0: "on",
          remote_name_1: "Server B",
          remote_host_1: "user@server-b",
          remote_path_1: "~/.claude/projects",
          // no remote_enabled_1 → disabled
        }),
      });

      expect(res.status).toBe(302);
      const saved = loadConfig(configPath);
      expect(saved.remote_sources).toHaveLength(2);
      expect(saved.remote_sources[0]!.enabled).toBe(true);
      expect(saved.remote_sources[1]!.enabled).toBe(false);
    });

    test("saves mix of sequential and timestamp indices", async () => {
      const app = createApp(db, syncManager);

      const res = await app.request("/settings", {
        method: "POST",
        body: settingsForm({
          remote_name_0: "Existing",
          remote_host_0: "user@existing",
          remote_path_0: "~/.claude/projects",
          remote_enabled_0: "on",
          remote_name_1709999999999: "Newly Added",
          remote_host_1709999999999: "user@new-host",
          remote_path_1709999999999: "/custom/path",
          remote_enabled_1709999999999: "on",
        }),
      });

      expect(res.status).toBe(302);
      const saved = loadConfig(configPath);
      expect(saved.remote_sources).toHaveLength(2);
      const existing = saved.remote_sources.find((r) => r.name === "Existing");
      const added = saved.remote_sources.find((r) => r.name === "Newly Added");
      expect(existing).toBeTruthy();
      expect(added).toBeTruthy();
      expect(added!.path).toBe("/custom/path");
    });

    test("saves auto_sync_interval", async () => {
      const app = createApp(db, syncManager);

      const form = settingsForm();
      form.set("auto_sync_interval", "30");

      const res = await app.request("/settings", {
        method: "POST",
        body: form,
      });

      expect(res.status).toBe(302);
      const saved = loadConfig(configPath);
      expect(saved.auto_sync_interval).toBe(30);
    });
  });

  describe("sync API routes", () => {
    test("GET /api/sync/status returns status HTML", async () => {
      const app = createApp(db, syncManager);
      const res = await app.request("/api/sync/status");
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("sync-status-panel");
      expect(html).toContain("No sync has run yet");
    });

    test("POST /api/sync returns syncing status", async () => {
      const app = createApp(db, syncManager);
      const res = await app.request("/api/sync", { method: "POST" });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("sync-status-panel");
    });
  });

  describe("Groups nav", () => {
    test("layout renders a Groups nav link", async () => {
      const { renderLayout } = await import("./views/layout");
      const html = renderLayout("X", { body: "<p>hi</p>", activeTab: "groups" });
      expect(html).toContain('href="/groups"');
      expect(html).toContain(">Groups<");
      // active class applied to the groups link
      expect(html).toMatch(/href="\/groups"\s+class="active"/);
    });
  });

  describe("Groups routes", () => {
    function seedSession(id: string) {
      db.query("INSERT OR IGNORE INTO projects (id, path, display_name) VALUES ('p','/tmp/p','Proj')").run();
      db.query(
        `INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at)
         VALUES (?, 'p', '/tmp/p', '/tmp/s.jsonl', '2026-07-10T00:00:00Z', 3, datetime('now'))`
      ).run(id);
    }

    test("GET /groups renders with Groups nav active", async () => {
      const app = createApp(db, syncManager);
      const res = await app.request("/groups");
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/href="\/groups"\s+class="active"/);
      expect(html).toContain("New group name");
    });

    test("POST /groups creates a group then redirects", async () => {
      const app = createApp(db, syncManager);
      const form = new FormData();
      form.append("name", "Trading");
      const res = await app.request("/groups", { method: "POST", body: form });
      expect(res.status).toBe(302);
      const rows = db.query("SELECT name FROM groups").all() as { name: string }[];
      expect(rows.map((r) => r.name)).toContain("Trading");
    });

    test("POST /groups with duplicate name shows error, not 500", async () => {
      const app = createApp(db, syncManager);
      db.query("INSERT INTO groups (name, created_at) VALUES ('Trading', datetime('now'))").run();
      const form = new FormData();
      form.append("name", "Trading");
      const res = await app.request("/groups", { method: "POST", body: form });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Group name already exists");
    });

    test("GET /groups/:id lists sessions; 404 for missing", async () => {
      const app = createApp(db, syncManager);
      seedSession("s1");
      const gid = (db.query("INSERT INTO groups (name, created_at) VALUES ('A', datetime('now')) RETURNING id").get() as { id: number }).id;
      db.query("INSERT INTO session_groups (session_id, group_id, assigned_at) VALUES ('s1', ?, datetime('now'))").run(gid);
      const ok = await app.request("/groups/" + gid);
      expect(ok.status).toBe(200);
      expect(await ok.text()).toContain('href="/session/s1"');
      const missing = await app.request("/groups/99999");
      expect(missing.status).toBe(404);
    });

    test("POST /groups/:id/rename and /delete", async () => {
      const app = createApp(db, syncManager);
      const gid = (db.query("INSERT INTO groups (name, created_at) VALUES ('A', datetime('now')) RETURNING id").get() as { id: number }).id;
      const rf = new FormData(); rf.append("name", "B");
      const r1 = await app.request("/groups/" + gid + "/rename", { method: "POST", body: rf });
      expect(r1.status).toBe(302);
      expect((db.query("SELECT name FROM groups WHERE id = ?").get(gid) as { name: string }).name).toBe("B");
      const r2 = await app.request("/groups/" + gid + "/delete", { method: "POST", body: new FormData() });
      expect(r2.status).toBe(302);
      expect(db.query("SELECT id FROM groups WHERE id = ?").get(gid)).toBeNull();
    });

    test("POST /sessions/:id/group files and unassigns a session", async () => {
      const app = createApp(db, syncManager);
      seedSession("s1");
      const gid = (db.query("INSERT INTO groups (name, created_at) VALUES ('A', datetime('now')) RETURNING id").get() as { id: number }).id;
      const assign = new FormData(); assign.append("group_id", String(gid));
      const r1 = await app.request("/sessions/s1/group", { method: "POST", body: assign });
      expect(r1.status).toBe(302);
      expect((db.query("SELECT group_id FROM session_groups WHERE session_id='s1'").get() as { group_id: number }).group_id).toBe(gid);
      const unassign = new FormData(); unassign.append("group_id", "");
      const r2 = await app.request("/sessions/s1/group", { method: "POST", body: unassign });
      expect(r2.status).toBe(302);
      expect(db.query("SELECT group_id FROM session_groups WHERE session_id='s1'").get()).toBeNull();
    });

    test("POST /sessions/:id/group with nonexistent group_id redirects, doesn't 500", async () => {
      const app = createApp(db, syncManager);
      seedSession("s1");
      const form = new FormData();
      form.append("group_id", "999999");
      const res = await app.request("/sessions/s1/group", { method: "POST", body: form });
      expect(res.status).toBe(302);
      expect(db.query("SELECT group_id FROM session_groups WHERE session_id='s1'").get()).toBeNull();
    });
  });
});
