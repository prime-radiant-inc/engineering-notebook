import { ClassicLevel } from "classic-level";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";

export type DesktopGroup = { desktopId: string; name: string };
export type DesktopAssignment = { cliSessionId: string; desktopGroupId: string };
export type DesktopGroupsData = { groups: DesktopGroup[]; assignments: DesktopAssignment[] };

export class DesktopGroupsFormatError extends Error {}

export function defaultLeveldbDir(): string {
  return join(homedir(), "Library/Application Support/Claude/Local Storage/leveldb");
}
export function defaultSessionsDir(): string {
  return join(homedir(), "Library/Application Support/Claude/claude-code-sessions");
}

/** Map Desktop session uuid (from local_<uuid>.json) -> cliSessionId. */
function buildSessionIdMap(sessionsDir: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(sessionsDir)) return map;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && entry.name.startsWith("local_") && entry.name.endsWith(".json")) {
        const uuid = entry.name.slice("local_".length, -".json".length);
        try {
          const data = JSON.parse(readFileSync(p, "utf-8"));
          if (typeof data.cliSessionId === "string") map.set(uuid, data.cliSessionId);
        } catch {
          /* skip unreadable session file */
        }
      }
    }
  };
  walk(sessionsDir);
  return map;
}

/**
 * Read Claude Desktop's session groups from its Chromium LocalStorage
 * (key `dframe-group-scopes`), joined to notebook session ids. Operates on a
 * snapshot copy so it is safe while the Desktop app is running.
 */
export async function readDesktopGroups(
  opts: { leveldbDir?: string; sessionsDir?: string } = {}
): Promise<DesktopGroupsData | null> {
  const leveldbDir = opts.leveldbDir ?? defaultLeveldbDir();
  const sessionsDir = opts.sessionsDir ?? defaultSessionsDir();
  if (!existsSync(leveldbDir)) return null;

  const temp = mkdtempSync(join(tmpdir(), "notebook-ldb-"));
  try {
    cpSync(leveldbDir, temp, { recursive: true });
    try { rmSync(join(temp, "LOCK")); } catch { /* copy may not have one */ }

    const db = new ClassicLevel(temp, { keyEncoding: "binary", valueEncoding: "binary" });
    await db.open();
    let raw: Buffer | null = null;
    try {
      for await (const [k, v] of db.iterator()) {
        if (Buffer.from(k as unknown as Uint8Array).toString("latin1").includes("dframe-group-scopes")) {
          raw = Buffer.from(v as unknown as Uint8Array);
          break;
        }
      }
    } finally {
      await db.close();
    }
    if (!raw) return null;

    const enc = raw[0];
    const text = enc === 0 ? raw.subarray(1).toString("utf16le") : raw.subarray(1).toString("latin1");
    let obj: any;
    try { obj = JSON.parse(text); }
    catch { throw new DesktopGroupsFormatError("dframe-group-scopes value is not valid JSON"); }

    const scopes = obj?.value;
    if (!scopes || typeof scopes !== "object") {
      throw new DesktopGroupsFormatError("unexpected dframe-group-scopes shape (missing .value)");
    }

    const sessionMap = buildSessionIdMap(sessionsDir);
    const groups: DesktopGroup[] = [];
    const assignments: DesktopAssignment[] = [];
    const seen = new Set<string>();

    for (const scope of Object.values<any>(scopes)) {
      if (!scope || !Array.isArray(scope.groups) || typeof scope.assignments !== "object" || scope.assignments === null) {
        throw new DesktopGroupsFormatError("unexpected scope shape (groups/assignments)");
      }
      for (const g of scope.groups) {
        if (g && typeof g.id === "string" && typeof g.name === "string" && !seen.has(g.id)) {
          seen.add(g.id);
          groups.push({ desktopId: g.id, name: g.name });
        }
      }
      for (const [assignKey, groupId] of Object.entries(scope.assignments)) {
        const m = /local_([0-9a-fA-F-]+)$/.exec(assignKey);
        if (!m || typeof groupId !== "string") continue;
        const cliSessionId = sessionMap.get(m[1]!);
        if (cliSessionId) assignments.push({ cliSessionId, desktopGroupId: groupId });
      }
    }
    return { groups, assignments };
  } finally {
    try { rmSync(temp, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

function defaultDesktopProbe(): boolean {
  try {
    const res = Bun.spawnSync(["pgrep", "-f", "Claude.app/Contents/MacOS/Claude"]);
    return res.exitCode === 0 && res.stdout.toString().trim().length > 0;
  } catch {
    return false;
  }
}
export function isClaudeDesktopRunning(): boolean {
  return defaultDesktopProbe();
}
