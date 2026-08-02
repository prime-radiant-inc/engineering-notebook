/**
 * OpenCode source adapter.
 *
 * OpenCode keeps sessions in a single SQLite database rather than one file per
 * session, so it cannot be scanned the way Claude Code and Codex sources are.
 * Instead we shell out to the supported CLI (`opencode session list` /
 * `opencode export`) and materialize one JSONL file per session into a staging
 * directory that the normal scanner can pick up.
 */

import { execFileSync } from "child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";
import { Database } from "bun:sqlite";

export type OpenCodePart = {
  type: string;
  text?: string;
};

export type OpenCodeMessage = {
  info: {
    role: string;
    time: { created: number };
  };
  parts: OpenCodePart[];
};

export type OpenCodeExport = {
  info: {
    id: string;
    directory: string;
    title?: string;
    version?: string;
    parentID?: string;
    model?: { providerID?: string; id?: string };
    time: { created: number; updated?: number };
  };
  messages: OpenCodeMessage[];
};

function isoFromMillis(millis: number): string {
  return new Date(millis).toISOString();
}

/** Join the text-bearing parts of a message, dropping step/tool bookkeeping. */
function messageText(message: OpenCodeMessage): string {
  return (message.parts || [])
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text!)
    .join("\n")
    .trim();
}

/**
 * Convert one `opencode export` payload into JSONL records that parser.ts
 * understands: an `opencode_meta` header followed by Claude-Code-shaped
 * user/assistant records.
 */
export function toJsonl(exp: OpenCodeExport): string {
  const model = exp.info.model;
  const lines: string[] = [
    JSON.stringify({
      type: "opencode_meta",
      timestamp: isoFromMillis(exp.info.time.created),
      payload: {
        id: exp.info.id,
        cwd: exp.info.directory,
        title: exp.info.title ?? "",
        version: exp.info.version ?? null,
        parent_id: exp.info.parentID ?? null,
        model:
          model?.providerID && model?.id
            ? `${model.providerID}/${model.id}`
            : null,
      },
    }),
  ];

  for (const message of exp.messages || []) {
    const text = messageText(message);
    if (!text) continue;

    const role = message.info.role === "assistant" ? "assistant" : "user";
    lines.push(
      JSON.stringify({
        type: role,
        timestamp: isoFromMillis(message.info.time.created),
        message: { role, content: text },
      })
    );
  }

  return lines.join("\n") + "\n";
}

export type OpenCodeSessionSummary = {
  id: string;
  title: string;
  created: number;
  updated: number;
  directory: string;
};

export type OpenCodeRunner = {
  listSessions(maxCount?: number): Promise<OpenCodeSessionSummary[]>;
  exportSession(id: string): Promise<OpenCodeExport>;
};

/**
 * Run a command and return its stdout, captured via a temporary file.
 *
 * The opencode CLI writes nothing at all when its stdout is a pipe, and a
 * single export can run to megabytes, so redirecting to a file is both the
 * working and the safe way to capture output.
 */
export function runToFile(binary: string, args: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "oc-run-"));
  const target = join(dir, "stdout");
  const fd = openSync(target, "w");
  try {
    execFileSync(binary, args, { stdio: ["ignore", fd, "ignore"] });
  } finally {
    closeSync(fd);
  }
  try {
    return readFileSync(target, "utf-8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function defaultOpenCodeDbPath(): string {
  return join(homedir(), ".local/share/opencode/opencode.db");
}

/**
 * Enumerate sessions straight from OpenCode's database.
 *
 * `opencode session list` only reports sessions belonging to the current
 * working directory's project, so it cannot see a whole tailnet of projects
 * from wherever ingest happens to run. Reading the session table is the only
 * way to enumerate everything; transcript content still comes from the CLI.
 */
export function listSessionsFromDb(
  dbPath = defaultOpenCodeDbPath(),
  maxCount?: number
): OpenCodeSessionSummary[] {
  if (!existsSync(dbPath)) return [];

  const db = new Database(dbPath, { readonly: true });
  try {
    const limit = maxCount ? ` LIMIT ${Number(maxCount)}` : "";
    const rows = db
      .query(
        `SELECT id, title, directory, time_created AS created, time_updated AS updated
         FROM session
         ORDER BY time_updated DESC${limit}`
      )
      .all() as OpenCodeSessionSummary[];
    return rows;
  } finally {
    db.close();
  }
}

/** Runner backed by OpenCode's database (listing) and CLI (export). */
export function cliRunner(
  binary = "opencode",
  dbPath = defaultOpenCodeDbPath()
): OpenCodeRunner {
  return {
    async listSessions(maxCount?: number) {
      return listSessionsFromDb(dbPath, maxCount);
    },

    async exportSession(id: string) {
      return JSON.parse(runToFile(binary, ["export", id])) as OpenCodeExport;
    },
  };
}

type Manifest = Record<string, number>;

function readManifest(path: string): Manifest {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Manifest;
  } catch {
    return {};
  }
}

/**
 * Export OpenCode sessions into `stagingDir` as one JSONL file per session.
 *
 * A manifest of last-seen `updated` times keeps repeat syncs cheap: only
 * sessions that changed since the previous run are re-exported.
 */
export async function syncOpenCodeSessions(
  stagingDir: string,
  runner: OpenCodeRunner,
  opts: { maxCount?: number } = {}
): Promise<{ written: number; skipped: number; errors: string[] }> {
  mkdirSync(stagingDir, { recursive: true });
  const manifestPath = join(stagingDir, "manifest.json");
  const manifest = readManifest(manifestPath);

  let written = 0;
  let skipped = 0;
  const errors: string[] = [];

  const sessions = await runner.listSessions(opts.maxCount);

  for (const session of sessions) {
    const target = join(stagingDir, `${session.id}.jsonl`);
    if (manifest[session.id] === session.updated && existsSync(target)) {
      skipped++;
      continue;
    }

    try {
      const exported = await runner.exportSession(session.id);
      writeFileSync(target, toJsonl(exported));
      manifest[session.id] = session.updated;
      written++;
    } catch (err) {
      errors.push(`${session.id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { written, skipped, errors };
}
