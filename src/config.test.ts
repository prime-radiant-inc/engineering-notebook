import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig, saveConfig, defaultConfig, expandPath, type Config } from "./config";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { tmpdir } from "os";

describe("config", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "notebook-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("defaultConfig has expected shape", () => {
    const config = defaultConfig();
    expect(config.sources).toEqual(["~/.claude/projects", "~/.codex/sessions"]);
    expect(config.exclude).toContain("-private-tmp*");
    expect(config.port).toBe(3000);
    expect(config.db_path).toContain("notebook.db");
  });

  test("loadConfig returns default when no file exists", () => {
    const config = loadConfig(join(tempDir, "nonexistent.json"));
    expect(config.sources).toEqual(["~/.claude/projects", "~/.codex/sessions"]);
  });

  test("saveConfig writes and loadConfig reads back", () => {
    const configPath = join(tempDir, "config.json");
    const config: Config = {
      sources: ["/custom/path"],
      exclude: ["test-*"],
      db_path: join(tempDir, "test.db"),
      port: 4000,
      day_start_hour: 5,
      summary_instructions: "",
      remote_sources: [],
      auto_sync_interval: 60,
    };
    saveConfig(configPath, config);
    const loaded = loadConfig(configPath);
    expect(loaded).toEqual(config);
  });

  test("migrates legacy default sources to include Codex sessions", () => {
    const configPath = join(tempDir, "legacy-config.json");
    writeFileSync(configPath, JSON.stringify({ sources: ["~/.claude/projects"] }));

    const loaded = loadConfig(configPath);
    expect(loaded.sources).toEqual(["~/.claude/projects", "~/.codex/sessions"]);
  });

  test("does not migrate custom single-source configs", () => {
    const configPath = join(tempDir, "custom-config.json");
    writeFileSync(configPath, JSON.stringify({ sources: ["/custom/path"] }));

    const loaded = loadConfig(configPath);
    expect(loaded.sources).toEqual(["/custom/path"]);
  });
});

describe("expandPath", () => {
  test("expands leading ~/ to home directory", () => {
    const result = expandPath("~/.claude/projects");
    expect(result).toBe(join(homedir(), ".claude/projects"));
  });

  test("leaves absolute paths unchanged", () => {
    const abs = "/usr/local/bin";
    expect(expandPath(abs)).toBe(abs);
  });

  test("leaves relative paths unchanged", () => {
    expect(expandPath("relative/path")).toBe("relative/path");
  });

  test("does not expand ~ without trailing slash", () => {
    expect(expandPath("~")).toBe("~");
  });
});

describe("opencode config", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "en-config-oc-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("is absent by default so the adapter stays opt-in", () => {
    const config = loadConfig(join(tempDir, "nonexistent.json"));
    expect(config.opencode).toBeUndefined();
  });

  test("round-trips an opencode block from the config file", () => {
    const configPath = join(tempDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        opencode: {
          enabled: true,
          staging_dir: "~/.cache/engineering-notebook/opencode",
          max_count: 50,
        },
      })
    );

    const loaded = loadConfig(configPath);
    expect(loaded.opencode?.enabled).toBe(true);
    expect(loaded.opencode?.staging_dir).toBe("~/.cache/engineering-notebook/opencode");
    expect(loaded.opencode?.max_count).toBe(50);
  });
});

describe("weekly report config", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "en-config-report-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("is absent by default so reports stay opt-in", () => {
    const config = loadConfig(join(tempDir, "nonexistent.json"));
    expect(config.report_template_url).toBeUndefined();
    expect(config.report_provider).toBeUndefined();
    expect(config.week_start_day).toBeUndefined();
  });

  test("round-trips the report fields", () => {
    const configPath = join(tempDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        week_start_day: 1,
        reports_dir: "~/reports",
        report_template_url: "https://example.com/t.md",
      })
    );
    const loaded = loadConfig(configPath);
    expect(loaded.week_start_day).toBe(1);
    expect(loaded.reports_dir).toBe("~/reports");
    expect(loaded.report_template_url).toBe("https://example.com/t.md");
  });
});
