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
    expect(config.summary_provider).toBe("claude");
    expect(config.summary_base_url).toBe("");
    expect(config.summary_model).toBe("");
    expect(config.summary_extras).toEqual({});
  });

  test("loadConfig rejects invalid summary_provider with a clear error", () => {
    const configPath = join(tempDir, "bad-provider.json");
    writeFileSync(configPath, JSON.stringify({ summary_provider: "ollama" }));
    expect(() => loadConfig(configPath)).toThrow(/Invalid summary_provider/);
  });

  test("loadConfig accepts openai-compat provider with extras", () => {
    const configPath = join(tempDir, "openai-compat.json");
    writeFileSync(configPath, JSON.stringify({
      summary_provider: "openai-compat",
      summary_base_url: "http://localhost:11434",
      summary_model: "qwen3.6:latest",
      summary_extras: { reasoning_effort: "none", temperature: 0.2 },
    }));
    const loaded = loadConfig(configPath);
    expect(loaded.summary_provider).toBe("openai-compat");
    expect(loaded.summary_extras).toEqual({ reasoning_effort: "none", temperature: 0.2 });
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
      summary_provider: "openai-compat",
      summary_base_url: "http://localhost:11434",
      summary_model: "qwen3.6:latest",
      summary_extras: { reasoning_effort: "none" },
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
