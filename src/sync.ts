import { mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { Database } from "bun:sqlite";
import type { RemoteSource, Config } from "./config";
import { expandPath } from "./config";
import { scanSources, ingestSessions } from "./ingest";

export type SyncResult = {
  name: string;
  success: boolean;
  cachedPath?: string;
  error?: string;
};

/** Sanitize a remote source name into a safe directory name */
export function cacheDir(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return join(
    homedir(),
    ".config",
    "engineering-notebook",
    "remotes",
    sanitized || "unnamed"
  );
}

/** Build the rsync command for a remote source */
export function buildRsyncCommand(
  source: RemoteSource,
  destDir: string
): string[] {
  return [
    "rsync",
    "-az",
    "--delete",
    "-e",
    "ssh -o BatchMode=yes -o ConnectTimeout=10",
    `${source.host}:${source.path}/`,
    destDir + "/",
  ];
}

/** Sync a single remote source. Returns the local cache path on success. */
export async function syncRemoteSource(
  source: RemoteSource
): Promise<SyncResult> {
  const dest = cacheDir(source.name);
  mkdirSync(dest, { recursive: true });

  const args = buildRsyncCommand(source, dest);
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    return { name: source.name, success: false, error: stderr.trim() };
  }

  return { name: source.name, success: true, cachedPath: dest };
}

/** Sync all enabled remote sources. Returns cache paths for successful syncs. */
export async function syncAllRemoteSources(
  sources: RemoteSource[],
  onProgress?: (result: SyncResult) => void
): Promise<{ cachedPaths: string[]; errors: string[] }> {
  const cachedPaths: string[] = [];
  const errors: string[] = [];

  for (const source of sources.filter((s) => s.enabled)) {
    const result = await syncRemoteSource(source);
    onProgress?.(result);
    if (result.success && result.cachedPath) {
      cachedPaths.push(result.cachedPath);
    } else {
      errors.push(`${source.name}: ${result.error}`);
    }
  }

  return { cachedPaths, errors };
}

/** Test SSH connectivity to a host. Returns null on success, error message on failure. */
export async function testConnection(host: string): Promise<string | null> {
  const proc = Bun.spawn(
    ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, "echo ok"],
    { stdout: "pipe", stderr: "pipe" }
  );
  const exitCode = await proc.exited;
  if (exitCode === 0) return null;
  const stderr = await new Response(proc.stderr).text();
  return stderr.trim() || `SSH connection failed (exit code ${exitCode})`;
}

// ──────────────────────────────────────────
// SyncManager — owns sync state and auto-sync timer
// ──────────────────────────────────────────

export type SummarizeStats = {
  summarized: number;
  skipped: number;
  errors: number;
};

export type SyncStatus = {
  inProgress: boolean;
  summarizeInProgress: boolean;
  lastRun: Date | null;
  lastResults: SyncResult[];
  lastIngestStats: { ingested: number; skipped: number; errors: number } | null;
  lastSummarizeRun: Date | null;
  lastSummarizeStats: SummarizeStats | null;
};

export class SyncManager {
  private status: SyncStatus = {
    inProgress: false,
    summarizeInProgress: false,
    lastRun: null,
    lastResults: [],
    lastIngestStats: null,
    lastSummarizeRun: null,
    lastSummarizeStats: null,
  };
  private timer: ReturnType<typeof setInterval> | null = null;
  private config: Config;
  private db: Database;

  constructor(config: Config, db: Database) {
    this.config = config;
    this.db = db;
  }

  getStatus(): SyncStatus {
    return { ...this.status };
  }

  /** Run sync + ingest. No-op if already in progress. */
  async runSync(): Promise<void> {
    if (this.status.inProgress) return;
    this.status.inProgress = true;
    try {
      const remoteSources =
        this.config.remote_sources?.filter((s) => s.enabled) || [];
      const results: SyncResult[] = [];
      if (remoteSources.length > 0) {
        const syncResult = await syncAllRemoteSources(remoteSources, (r) =>
          results.push(r)
        );
        const sources = this.config.sources.map(expandPath);
        sources.push(...syncResult.cachedPaths);
        const files = scanSources(sources, this.config.exclude);
        const ingestResult = ingestSessions(files, this.db, false);
        this.status.lastIngestStats = {
          ingested: ingestResult.ingested,
          skipped: ingestResult.skipped,
          errors: ingestResult.errors.length,
        };
      }
      this.status.lastResults = results;
      this.status.lastRun = new Date();
    } finally {
      this.status.inProgress = false;
    }
  }

  /** Start the auto-sync timer. */
  startTimer(): void {
    this.stopTimer();
    const interval = this.config.auto_sync_interval;
    if (interval > 0) {
      this.timer = setInterval(() => this.runSync(), interval * 60 * 1000);
    }
  }

  stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run summarization for unsummarized session groups. No-op if already running. */
  async runSummarize(): Promise<void> {
    if (this.status.summarizeInProgress) return;
    this.status.summarizeInProgress = true;
    try {
      const { summarizeAll } = await import("./summarize");
      const result = await summarizeAll(
        this.db,
        undefined,
        undefined,
        undefined,
        this.config.day_start_hour
      );
      this.status.lastSummarizeStats = {
        summarized: result.summarized,
        skipped: result.skipped,
        errors: result.errors.length,
      };
      this.status.lastSummarizeRun = new Date();
    } finally {
      this.status.summarizeInProgress = false;
    }
  }

  /** Summarize a single project+date on demand. Returns the new journal entry ID or null if skipped. */
  async summarizeGroup(projectId: string, date: string): Promise<number | null> {
    const { groupSessionsByDateAndProject, summarizeGroup } = await import("./summarize");
    const groups = groupSessionsByDateAndProject(
      this.db, date, projectId, this.config.day_start_hour
    );
    if (groups.length === 0) return null;
    const result = await summarizeGroup(groups[0]!, this.db);
    if (result.skipped) return null;
    const row = this.db.query(
      `SELECT id FROM journal_entries WHERE project_id = ? AND date = ?`
    ).get(projectId, date) as { id: number } | null;
    return row?.id ?? null;
  }

  /** Reload config (called after settings save). */
  updateConfig(config: Config): void {
    this.config = config;
    this.startTimer();
  }
}
