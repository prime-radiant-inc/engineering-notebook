import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

export type RemoteSource = {
  name: string;
  host: string;
  path: string;
  enabled: boolean;
};

export const SUMMARY_PROVIDERS = ["claude", "openai-compat"] as const;
export type SummaryProvider = (typeof SUMMARY_PROVIDERS)[number];

export type Config = {
  sources: string[];
  exclude: string[];
  db_path: string;
  port: number;
  day_start_hour: number;
  summary_instructions: string;
  summary_provider: SummaryProvider;
  summary_base_url: string;
  summary_model: string;
  summary_extras: Record<string, unknown>;
  remote_sources: RemoteSource[];
  auto_sync_interval: number;
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
    summary_provider: "claude",
    summary_base_url: "",
    summary_model: "",
    summary_extras: {},
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

  if (
    parsed.summary_provider !== undefined &&
    !SUMMARY_PROVIDERS.includes(parsed.summary_provider)
  ) {
    throw new Error(
      `Invalid summary_provider "${parsed.summary_provider}" in ${configPath}. ` +
        `Must be one of: ${SUMMARY_PROVIDERS.join(", ")}.`
    );
  }

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
