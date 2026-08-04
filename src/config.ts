import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import type { SummaryProvider } from "./llm";

export type RemoteSource = {
  name: string;
  host: string;
  path: string;
  enabled: boolean;
};

export type OpenCodeConfig = {
  enabled: boolean;
  /** Where exported sessions are staged for the scanner. */
  staging_dir: string;
  /** Limit to the N most recent sessions; omit for all. */
  max_count?: number;
};

export type Config = {
  sources: string[];
  exclude: string[];
  db_path: string;
  port: number;
  day_start_hour: number;
  summary_instructions: string;
  remote_sources: RemoteSource[];
  auto_sync_interval: number;
  /** Optional and absent by default: the OpenCode adapter is opt-in. */
  opencode?: OpenCodeConfig;
  /** Which model writes journal entries and session titles. Claude by default. */
  summary_provider?: SummaryProvider;
  /** First day of the reporting week: 0 = Sunday, 1 = Monday. Defaults to 1. */
  week_start_day?: number;
  /** Where weekly report markdown is exported. */
  reports_dir?: string;
  /** URL of the report prompt template. Unset means use the shipped default. */
  report_template_url?: string;
  /** Where the last successfully fetched template is cached. */
  report_template_cache?: string;
  /** Model for weekly reports. Falls back to summary_provider when unset. */
  report_provider?: SummaryProvider;
};

export function defaultConfig(): Config {
  const configDir = join(homedir(), ".config", "engineering-notebook");
  return {
    sources: ["~/.claude/projects", "~/.codex/sessions"],
    exclude: ["-private-tmp*", "*-skill-test-*"],
    db_path: join(configDir, "notebook.db"),
    port: 3000,
    day_start_hour: 5,
    summary_instructions: "",
    remote_sources: [],
    auto_sync_interval: 60,
  };
}

export function resolveConfigPath(): string {
  return join(homedir(), ".config", "engineering-notebook", "config.json");
}

export function loadConfig(path?: string): Config {
  const configPath = path ?? resolveConfigPath();
  if (!existsSync(configPath)) {
    return defaultConfig();
  }
  const raw = readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(raw) as Partial<Config>;
  const config = { ...defaultConfig(), ...parsed };

  // Migrate older default source list to include Codex sessions.
  if (
    Array.isArray(parsed.sources) &&
    parsed.sources.length === 1 &&
    parsed.sources[0] === "~/.claude/projects"
  ) {
    config.sources = defaultConfig().sources;
  }

  return config;
}

export function saveConfig(path: string, config: Config): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
}

/** Expand ~ to homedir in a path */
export function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}
