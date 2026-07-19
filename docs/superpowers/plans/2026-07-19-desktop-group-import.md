# Desktop Group Import (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import the user's Claude Desktop groups (Tolaria/OpenBB/Cashins Comments) and their session assignments into the notebook, add an Ungrouped view, and block group edits while Claude Desktop is running.

**Architecture:** A new `src/desktop-groups.ts` reads Claude Desktop's Chromium LocalStorage (`dframe-group-scopes`) from a snapshot copy using `classic-level`, normalizes it, and joins Desktop session ids to notebook session ids. `importDesktopGroups` in `src/groups.ts` reconciles those into the existing `groups`/`session_groups` tables (mirroring Desktop by `desktop_id`, leaving manual groups untouched). New routes/CLI expose a "Sync from Claude Desktop" action and an Ungrouped page. A single policy switch blocks group-mutating routes while Desktop runs.

**Tech Stack:** Bun, bun:sqlite, Hono, TypeScript, `classic-level` (new dep), `bun test`.

## Global Constraints

- Runtime **Bun**; verify with `bun run check` (`bun test` + `bun --bun tsc --noEmit`). Pre-commit hook runs both.
- New dependency **`classic-level`** is permitted for this feature (a maintained LevelDB binding; confirmed working under Bun v1.3.14, opens a snapshot copy of the Desktop store). No other new deps.
- DB uses `PRAGMA foreign_keys = ON`. `session_groups.group_id` has `ON DELETE CASCADE`; `session_groups.session_id` has NO FK. Keep it that way.
- `groups.name` is UNIQUE — **keep it**. Import matches groups by `desktop_id`; a Desktop group whose name collides with a different-identity group is skipped and counted, not force-inserted.
- **Phase 1 is read-only toward Desktop.** The reader operates only on a temp **copy** of the Desktop store and never writes to `~/Library/Application Support/Claude`.
- **Desktop data shape** (pinned against the real store): the localStorage key contains `dframe-group-scopes`; value is `0x01` + Latin-1 JSON (byte `0x00` would mean UTF-16LE). Decoded JSON:
  ```
  { "value": { "<account>/<org>": {
      "groups": [ { "id": "cg-<uuid>", "name": "Tolaria" }, ... ],
      "assignments": { "code:local_<uuid>": "cg-<uuid>", ... } } },
    "tabId": "...", "timestamp": ... }
  ```
- **Join:** an assignment key `code:local_<uuid>` → file `claude-code-sessions/**/local_<uuid>.json` → its `cliSessionId` → notebook `sessions.id`.
- **Guard:** `GROUP_EDIT_POLICY` = `"block"` this phase; group-mutating routes are blocked (no mutation, banner shown) while Desktop runs; the import action is exempt. The running-probe is overridable for tests.
- All user text via `escapeHtml`. Follow existing patterns (inline `db.query`, Hono form-POST + redirect, string-concat views).
- Tests must assert real behavior and be green before each commit. Branch: `feature/session-groups`.

---

### Task 1: Migration — `desktop_id` column on `groups`

**Files:**
- Modify: `src/db.ts` (add a partial unique index to the schema `db.exec` block; add one `ALTER TABLE` in the migrations try/catch section near lines 71-81)
- Test: `src/db.test.ts`

**Interfaces:**
- Produces: `groups.desktop_id TEXT` (nullable) + `CREATE UNIQUE INDEX idx_groups_desktop_id ON groups(desktop_id) WHERE desktop_id IS NOT NULL`.

- [ ] **Step 1: Write the failing test**

Add to `src/db.test.ts` inside `describe("db", ...)`:

```ts
test("groups has a nullable desktop_id column with a partial unique index", () => {
  const db = initDb(dbPath);
  const cols = db.query("PRAGMA table_info(groups)").all() as { name: string; notnull: number }[];
  const desktop = cols.find((c) => c.name === "desktop_id");
  expect(desktop).toBeTruthy();
  expect(desktop!.notnull).toBe(0);
  // two manual groups (NULL desktop_id) coexist; two rows sharing a non-null desktop_id are rejected
  db.query("INSERT INTO groups (name, created_at) VALUES ('m1', datetime('now'))").run();
  db.query("INSERT INTO groups (name, created_at) VALUES ('m2', datetime('now'))").run();
  db.query("INSERT INTO groups (name, created_at, desktop_id) VALUES ('d1', datetime('now'), 'cg-x')").run();
  expect(() =>
    db.query("INSERT INTO groups (name, created_at, desktop_id) VALUES ('d2', datetime('now'), 'cg-x')").run()
  ).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/db.test.ts`
Expected: FAIL — no `desktop_id` column.

- [ ] **Step 3: Implement**

3a. In `src/db.ts`, add the partial index to the `db.exec(\`...\`)` schema block, right after the existing `idx_session_groups_group` index line:

```sql
    CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_desktop_id ON groups(desktop_id) WHERE desktop_id IS NOT NULL;
```

3b. Add a migration in the try/catch section (after the `is_subagent` migration near line 81):

```ts
  try {
    db.exec(`ALTER TABLE groups ADD COLUMN desktop_id TEXT`);
  } catch {
    // Column already exists — ignore
  }
```

Note: the `ALTER TABLE` must run before the index is used, but since both are idempotent and `initDb` runs the schema `exec` (creating the index only if the column exists on fresh DBs) — for existing DBs the ALTER adds the column, and the `CREATE INDEX IF NOT EXISTS` in the schema block runs on the next `initDb`. To guarantee order on a fresh AND existing DB, also create the index in the migration block right after the ALTER:

```ts
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_desktop_id ON groups(desktop_id) WHERE desktop_id IS NOT NULL`);
  } catch {
    // Index already exists — ignore
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/db.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat(desktop-import): add groups.desktop_id column + partial unique index"
```

---

### Task 2: Desktop reader module — `src/desktop-groups.ts`

**Files:**
- Create: `src/desktop-groups.ts`
- Test: `src/desktop-groups.test.ts`
- Modify: `package.json` (add `classic-level` dependency via `bun add`)

**Interfaces:**
- Produces:
  - `type DesktopGroup = { desktopId: string; name: string }`
  - `type DesktopAssignment = { cliSessionId: string; desktopGroupId: string }`
  - `type DesktopGroupsData = { groups: DesktopGroup[]; assignments: DesktopAssignment[] }`
  - `class DesktopGroupsFormatError extends Error`
  - `defaultLeveldbDir(): string`, `defaultSessionsDir(): string`
  - `readDesktopGroups(opts?: { leveldbDir?: string; sessionsDir?: string }): Promise<DesktopGroupsData | null>`
  - `isClaudeDesktopRunning(): boolean`, `__setDesktopRunningProbe(fn: (() => boolean) | null): void`
  - `GROUP_EDIT_POLICY: "block" | "warn"`, `groupEditBlocked(): boolean`

- [ ] **Step 1: Add the dependency**

Run: `bun add classic-level`
Expected: `classic-level` added to `package.json` dependencies; `bun install` succeeds.

- [ ] **Step 2: Write the failing test**

Create `src/desktop-groups.test.ts`. It builds a synthetic Desktop store with `classic-level` (same lib the reader uses) and synthetic `local_*.json` files, so no real data is needed:

```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { ClassicLevel } from "classic-level";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  readDesktopGroups, isClaudeDesktopRunning, __setDesktopRunningProbe,
  groupEditBlocked, GROUP_EDIT_POLICY, DesktopGroupsFormatError,
} from "./desktop-groups";

async function writeStore(dir: string, valueObj: unknown, enc: 0 | 1 = 1) {
  const db = new ClassicLevel(dir, { keyEncoding: "binary", valueEncoding: "binary" });
  await db.open();
  const key = Buffer.concat([
    Buffer.from("_https://claude.ai", "latin1"),
    Buffer.from([0x00, 0x01]),
    Buffer.from("LSS-persisted.dframe-group-scopes", "latin1"),
  ]);
  const json = JSON.stringify(valueObj);
  const body = enc === 0 ? Buffer.from(json, "utf16le") : Buffer.from(json, "latin1");
  await db.put(key, Buffer.concat([Buffer.from([enc]), body]));
  await db.close();
}

function writeSession(sessionsDir: string, uuid: string, cliSessionId: string) {
  const scope = join(sessionsDir, "acct", "org");
  mkdirSync(scope, { recursive: true });
  writeFileSync(join(scope, `local_${uuid}.json`), JSON.stringify({ sessionId: `local_${uuid}`, cliSessionId }));
}

describe("desktop-groups reader", () => {
  let tmp: string, leveldbDir: string, sessionsDir: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "dg-test-"));
    leveldbDir = join(tmp, "leveldb");
    sessionsDir = join(tmp, "sessions");
  });
  afterEach(() => { __setDesktopRunningProbe(null); rmSync(tmp, { recursive: true, force: true }); });

  const sample = {
    value: {
      "acct/org": {
        groups: [
          { id: "cg-1", name: "Tolaria" },
          { id: "cg-2", name: "OpenBB" },
        ],
        assignments: {
          "code:local_uuidA": "cg-1",
          "code:local_uuidB": "cg-2",
          "code:local_missing": "cg-1",
        },
      },
    },
    tabId: "t", timestamp: 1,
  };

  test("reads and normalizes groups + assignments, joining to cliSessionId", async () => {
    await writeStore(leveldbDir, sample);
    writeSession(sessionsDir, "uuidA", "cli-A");
    writeSession(sessionsDir, "uuidB", "cli-B");
    // 'missing' has no local_ file → dropped
    const data = (await readDesktopGroups({ leveldbDir, sessionsDir }))!;
    expect(data.groups).toEqual([
      { desktopId: "cg-1", name: "Tolaria" },
      { desktopId: "cg-2", name: "OpenBB" },
    ]);
    expect(data.assignments.sort((a, b) => a.cliSessionId.localeCompare(b.cliSessionId))).toEqual([
      { cliSessionId: "cli-A", desktopGroupId: "cg-1" },
      { cliSessionId: "cli-B", desktopGroupId: "cg-2" },
    ]);
  });

  test("returns null when the leveldb dir does not exist", async () => {
    expect(await readDesktopGroups({ leveldbDir: join(tmp, "nope"), sessionsDir })).toBeNull();
  });

  test("returns null when the key is absent", async () => {
    const db = new ClassicLevel(leveldbDir, { keyEncoding: "binary", valueEncoding: "binary" });
    await db.open(); await db.put(Buffer.from("other"), Buffer.from("x")); await db.close();
    expect(await readDesktopGroups({ leveldbDir, sessionsDir })).toBeNull();
  });

  test("throws DesktopGroupsFormatError on unrecognized shape", async () => {
    await writeStore(leveldbDir, { value: { "acct/org": { nope: true } }, tabId: "t", timestamp: 1 });
    await expect(readDesktopGroups({ leveldbDir, sessionsDir })).rejects.toBeInstanceOf(DesktopGroupsFormatError);
  });

  test("guard: probe override drives isClaudeDesktopRunning / groupEditBlocked", () => {
    __setDesktopRunningProbe(() => true);
    expect(isClaudeDesktopRunning()).toBe(true);
    expect(groupEditBlocked()).toBe(GROUP_EDIT_POLICY === "block");
    __setDesktopRunningProbe(() => false);
    expect(isClaudeDesktopRunning()).toBe(false);
    expect(groupEditBlocked()).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test src/desktop-groups.test.ts`
Expected: FAIL — `Cannot find module './desktop-groups'`.

- [ ] **Step 4: Implement `src/desktop-groups.ts`**

```ts
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
        } catch { /* skip unreadable session file */ }
      }
    }
  };
  walk(sessionsDir);
  return map;
}

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
        const cliSessionId = sessionMap.get(m[1]);
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
    return false; // fail-open: never wedge the notebook on a detection error
  }
}

let _probe: () => boolean = defaultDesktopProbe;
export function isClaudeDesktopRunning(): boolean { return _probe(); }
export function __setDesktopRunningProbe(fn: (() => boolean) | null): void {
  _probe = fn ?? defaultDesktopProbe;
}

export const GROUP_EDIT_POLICY: "block" | "warn" = "block";
export function groupEditBlocked(): boolean {
  return GROUP_EDIT_POLICY === "block" && isClaudeDesktopRunning();
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/desktop-groups.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Spike — verify against the REAL store (manual, no commit of real data)**

Run this one-off (does NOT get committed; confirms the reader works on the live store):

```bash
bun -e 'import { readDesktopGroups } from "./src/desktop-groups"; const d = await readDesktopGroups(); console.log("groups:", d?.groups); console.log("assignments:", d?.assignments.length);'
```

Expected: prints groups including `Tolaria`, `OpenBB`, `Cashins Comments`, and a non-zero assignment count. Record the output in the task report. Do not add real data to any test fixture.

- [ ] **Step 7: Commit**

```bash
git add src/desktop-groups.ts src/desktop-groups.test.ts package.json bun.lock
git commit -m "feat(desktop-import): add Desktop LocalStorage reader + running-probe"
```

---

### Task 3: Import / reconcile — `importDesktopGroups` in `src/groups.ts`

**Files:**
- Modify: `src/groups.ts` (add `importDesktopGroups` + `ImportSummary`)
- Test: `src/groups.test.ts`

**Interfaces:**
- Consumes: `DesktopGroupsData` from `./desktop-groups`.
- Produces:
  - `type ImportSummary = { groupsAdded: number; groupsRenamed: number; groupsRemoved: number; sessionsAssigned: number; skippedNoSession: number; skippedNameCollision: number }`
  - `importDesktopGroups(db: Database, data: DesktopGroupsData): ImportSummary`

- [ ] **Step 1: Write the failing test**

Add to `src/groups.test.ts` (reuse the existing `seedProject`/`seedSession` helpers in that file):

```ts
import { importDesktopGroups } from "./groups";
import type { DesktopGroupsData } from "./desktop-groups";

describe("importDesktopGroups", () => {
  let tempDir: string;
  let db: ReturnType<typeof initDb>;
  function seedProject(id = "p") {
    db.query("INSERT OR IGNORE INTO projects (id, path, display_name) VALUES (?, ?, ?)").run(id, "/tmp/" + id, id);
  }
  function seedSession(id: string) {
    db.query(
      `INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at)
       VALUES (?, 'p', '/tmp/p', '/tmp/s.jsonl', '2026-07-10T00:00:00Z', 3, datetime('now'))`
    ).run(id);
  }
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), "imp-test-")); db = initDb(join(tempDir, "t.db")); seedProject(); });
  afterEach(() => { closeDb(); rmSync(tempDir, { recursive: true, force: true }); });

  const data = (): DesktopGroupsData => ({
    groups: [{ desktopId: "cg-1", name: "Tolaria" }, { desktopId: "cg-2", name: "OpenBB" }],
    assignments: [
      { cliSessionId: "s1", desktopGroupId: "cg-1" },
      { cliSessionId: "s2", desktopGroupId: "cg-2" },
      { cliSessionId: "sMissing", desktopGroupId: "cg-1" },
    ],
  });

  test("creates desktop groups, assigns existing sessions, skips missing", () => {
    seedSession("s1"); seedSession("s2");
    const sum = importDesktopGroups(db, data());
    expect(sum.groupsAdded).toBe(2);
    expect(sum.sessionsAssigned).toBe(2);
    expect(sum.skippedNoSession).toBe(1);
    const tol = db.query("SELECT id FROM groups WHERE desktop_id='cg-1'").get() as { id: number };
    expect((db.query("SELECT group_id FROM session_groups WHERE session_id='s1'").get() as any).group_id).toBe(tol.id);
  });

  test("is idempotent and renames when Desktop renames", () => {
    seedSession("s1"); seedSession("s2");
    importDesktopGroups(db, data());
    const second = { ...data(), groups: [{ desktopId: "cg-1", name: "Tolaria2" }, { desktopId: "cg-2", name: "OpenBB" }] };
    const sum = importDesktopGroups(db, second);
    expect(sum.groupsAdded).toBe(0);
    expect(sum.groupsRenamed).toBe(1);
    expect((db.query("SELECT name FROM groups WHERE desktop_id='cg-1'").get() as any).name).toBe("Tolaria2");
    expect((db.query("SELECT COUNT(*) c FROM groups WHERE desktop_id IS NOT NULL").get() as any).c).toBe(2);
  });

  test("removes desktop groups dropped from Desktop; leaves manual groups untouched", () => {
    seedSession("s1"); seedSession("s2");
    createGroup(db, "MyManual"); // desktop_id NULL
    importDesktopGroups(db, data());
    const only = { groups: [{ desktopId: "cg-1", name: "Tolaria" }], assignments: [{ cliSessionId: "s1", desktopGroupId: "cg-1" }] };
    const sum = importDesktopGroups(db, only);
    expect(sum.groupsRemoved).toBe(1); // cg-2 removed
    expect(db.query("SELECT id FROM groups WHERE desktop_id='cg-2'").get()).toBeNull();
    expect(db.query("SELECT id FROM groups WHERE name='MyManual'").get()).toBeTruthy();
  });

  test("mirror: session hand-moved off a desktop group snaps back on re-import", () => {
    seedSession("s1");
    importDesktopGroups(db, { groups: [{ desktopId: "cg-1", name: "Tolaria" }], assignments: [{ cliSessionId: "s1", desktopGroupId: "cg-1" }] });
    assignSession(db, "s1", null); // user unassigns
    const sum = importDesktopGroups(db, { groups: [{ desktopId: "cg-1", name: "Tolaria" }], assignments: [{ cliSessionId: "s1", desktopGroupId: "cg-1" }] });
    expect(sum.sessionsAssigned).toBe(1);
    expect(getSessionGroupId(db, "s1")).toBe((db.query("SELECT id FROM groups WHERE desktop_id='cg-1'").get() as any).id);
  });

  test("skips a desktop group whose name collides with a manual group", () => {
    seedSession("s1");
    createGroup(db, "Tolaria"); // manual, same name
    const sum = importDesktopGroups(db, { groups: [{ desktopId: "cg-1", name: "Tolaria" }], assignments: [] });
    expect(sum.skippedNameCollision).toBe(1);
    expect(sum.groupsAdded).toBe(0);
    expect(db.query("SELECT desktop_id FROM groups WHERE name='Tolaria'").get()).toEqual({ desktop_id: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/groups.test.ts`
Expected: FAIL — `importDesktopGroups` not exported.

- [ ] **Step 3: Implement in `src/groups.ts`**

Add the import type and function (append to the module):

```ts
import type { DesktopGroupsData } from "./desktop-groups";

export type ImportSummary = {
  groupsAdded: number;
  groupsRenamed: number;
  groupsRemoved: number;
  sessionsAssigned: number;
  skippedNoSession: number;
  skippedNameCollision: number;
};

export function importDesktopGroups(db: Database, data: DesktopGroupsData): ImportSummary {
  const summary: ImportSummary = {
    groupsAdded: 0, groupsRenamed: 0, groupsRemoved: 0,
    sessionsAssigned: 0, skippedNoSession: 0, skippedNameCollision: 0,
  };

  db.transaction(() => {
    const desktopIdToGroupId = new Map<string, number>();

    // Upsert desktop groups by desktop_id.
    for (const g of data.groups) {
      const existing = db.query("SELECT id, name FROM groups WHERE desktop_id = ?").get(g.desktopId) as
        | { id: number; name: string } | null;
      if (existing) {
        if (existing.name !== g.name) {
          const clash = db.query("SELECT id FROM groups WHERE name = ? AND id != ?").get(g.name, existing.id) as { id: number } | null;
          if (!clash) { db.query("UPDATE groups SET name = ? WHERE id = ?").run(g.name, existing.id); summary.groupsRenamed++; }
        }
        desktopIdToGroupId.set(g.desktopId, existing.id);
      } else {
        const clash = db.query("SELECT id FROM groups WHERE name = ?").get(g.name) as { id: number } | null;
        if (clash) { summary.skippedNameCollision++; continue; }
        const row = db.query(
          "INSERT INTO groups (name, created_at, desktop_id) VALUES (?, datetime('now'), ?) RETURNING id"
        ).get(g.name, g.desktopId) as { id: number };
        desktopIdToGroupId.set(g.desktopId, row.id);
        summary.groupsAdded++;
      }
    }

    // Remove desktop-sourced groups no longer present in Desktop (cascade clears memberships).
    const present = new Set(data.groups.map((g) => g.desktopId));
    for (const eg of db.query("SELECT id, desktop_id FROM groups WHERE desktop_id IS NOT NULL").all() as { id: number; desktop_id: string }[]) {
      if (!present.has(eg.desktop_id)) { db.query("DELETE FROM groups WHERE id = ?").run(eg.id); summary.groupsRemoved++; }
    }

    // Mirror membership for desktop groups: clear all desktop-group memberships, then re-add from Desktop.
    db.query("DELETE FROM session_groups WHERE group_id IN (SELECT id FROM groups WHERE desktop_id IS NOT NULL)").run();
    for (const a of data.assignments) {
      const gid = desktopIdToGroupId.get(a.desktopGroupId);
      if (gid === undefined) continue; // group skipped/unknown
      const sess = db.query("SELECT id FROM sessions WHERE id = ?").get(a.cliSessionId);
      if (!sess) { summary.skippedNoSession++; continue; }
      db.query(
        `INSERT INTO session_groups (session_id, group_id, assigned_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(session_id) DO UPDATE SET group_id = excluded.group_id, assigned_at = excluded.assigned_at`
      ).run(a.cliSessionId, gid);
      summary.sessionsAssigned++;
    }
  })();

  return summary;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/groups.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/groups.ts src/groups.test.ts
git commit -m "feat(desktop-import): reconcile Desktop groups into notebook (mirror by desktop_id)"
```

---

### Task 4: Ungrouped view + Groups-index entry

**Files:**
- Modify: `src/web/views/groups.ts` (add `renderUngrouped`; add an "Ungrouped (N)" entry to `renderGroupsIndex`)
- Test: `src/web/views/groups.test.ts`

**Interfaces:**
- Produces: `renderUngrouped(db: Database, page: number): string` (100/page, most-recent first, "N of M" count, prev/next).
- `renderGroupsIndex` output additionally contains an `href="/groups/ungrouped"` entry with the ungrouped count.

- [ ] **Step 1: Write the failing test**

Add to `src/web/views/groups.test.ts` (reuse its `seed` helper; add more sessions):

```ts
import { renderUngrouped } from "./groups";

describe("ungrouped view", () => {
  let tempDir: string;
  let db: ReturnType<typeof initDb>;
  function seedSession(id: string, started: string) {
    db.query("INSERT OR IGNORE INTO projects (id, path, display_name) VALUES ('p','/tmp/p','Proj')").run();
    db.query(
      `INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at)
       VALUES (?, 'p', '/tmp/p', '/tmp/s.jsonl', ?, 3, datetime('now'))`
    ).run(id, started);
  }
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), "ung-test-")); db = initDb(join(tempDir, "t.db")); });
  afterEach(() => { closeDb(); rmSync(tempDir, { recursive: true, force: true }); });

  test("index shows an Ungrouped entry with the count", () => {
    seedSession("s1", "2026-07-01T00:00:00Z");
    seedSession("s2", "2026-07-02T00:00:00Z");
    const g = createGroup(db, "G");
    assignSession(db, "s1", g);
    const html = renderGroupsIndex(db); // from existing import
    expect(html).toContain('href="/groups/ungrouped"');
    expect(html).toMatch(/Ungrouped[\s\S]*1/); // one ungrouped (s2)
  });

  test("renderUngrouped lists only ungrouped sessions, most-recent first", () => {
    seedSession("s1", "2026-07-01T00:00:00Z");
    seedSession("s2", "2026-07-03T00:00:00Z");
    seedSession("s3", "2026-07-02T00:00:00Z");
    const g = createGroup(db, "G");
    assignSession(db, "s2", g); // grouped → excluded
    const html = renderUngrouped(db, 1);
    expect(html).toContain('href="/session/s1"');
    expect(html).toContain('href="/session/s3"');
    expect(html).not.toContain('href="/session/s2"');
    // most-recent first: s3 (07-02) before s1 (07-01)
    expect(html.indexOf("/session/s3")).toBeLessThan(html.indexOf("/session/s1"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/web/views/groups.test.ts`
Expected: FAIL — `renderUngrouped` missing and no Ungrouped entry.

- [ ] **Step 3: Implement in `src/web/views/groups.ts`**

3a. In `renderGroupsIndex`, after the group list loop (before the closing `</div>`), add an Ungrouped entry:

```ts
  const ungroupedCount = (db.query(
    `SELECT COUNT(*) AS c FROM sessions s WHERE NOT EXISTS (SELECT 1 FROM session_groups sg WHERE sg.session_id = s.id)`
  ).get() as { c: number }).c;
  html += `<div style="padding:10px 0; border-top:1px solid var(--border-subtle); display:flex; justify-content:space-between;">`;
  html += `<a href="/groups/ungrouped">Ungrouped</a>`;
  html += `<span style="color:var(--text-ghost); font-size:12px;">${ungroupedCount} session(s)</span>`;
  html += `</div>`;
```

3b. Add `renderUngrouped`:

```ts
export function renderUngrouped(db: Database, page: number): string {
  const perPage = 100;
  const p = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const total = (db.query(
    `SELECT COUNT(*) AS c FROM sessions s WHERE NOT EXISTS (SELECT 1 FROM session_groups sg WHERE sg.session_id = s.id)`
  ).get() as { c: number }).c;
  const rows = db.query(
    `SELECT s.id, p.display_name, s.started_at, s.message_count
     FROM sessions s JOIN projects p ON p.id = s.project_id
     WHERE NOT EXISTS (SELECT 1 FROM session_groups sg WHERE sg.session_id = s.id)
     ORDER BY s.started_at DESC LIMIT ? OFFSET ?`
  ).all(perPage, (p - 1) * perPage) as { id: string; display_name: string; started_at: string; message_count: number }[];

  const from = total === 0 ? 0 : (p - 1) * perPage + 1;
  const to = (p - 1) * perPage + rows.length;
  let html = `<div style="max-width: 720px; margin: 0 auto; padding: 24px;">`;
  html += `<div style="margin-bottom:16px;"><a href="/groups">&larr; Groups</a></div>`;
  html += `<div class="page-title">Ungrouped</div>`;
  html += `<div style="color:var(--text-ghost); font-size:12px; margin-bottom:12px;">${from}–${to} of ${total}</div>`;
  if (rows.length === 0) {
    html += `<div class="empty-state">No ungrouped sessions.</div>`;
  } else {
    for (const s of rows) {
      html += `<div style="padding:8px 0; border-bottom:1px solid var(--border-subtle);">`;
      html += `<a href="/session/${escapeHtml(s.id)}">${escapeHtml(s.display_name)}</a>`;
      html += `<div style="color:var(--text-ghost); font-size:12px;">${s.started_at.slice(0, 10)} · ${s.message_count} messages</div>`;
      html += `</div>`;
    }
    html += `<div style="display:flex; gap:12px; margin-top:16px;">`;
    if (p > 1) html += `<a href="/groups/ungrouped?page=${p - 1}">&larr; Prev</a>`;
    if (to < total) html += `<a href="/groups/ungrouped?page=${p + 1}">Next &rarr;</a>`;
    html += `</div>`;
  }
  html += `</div>`;
  return html;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/web/views/groups.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/views/groups.ts src/web/views/groups.test.ts
git commit -m "feat(desktop-import): add Ungrouped view + index entry"
```

---

### Task 5: Desktop-open guard on the mutating routes

**Files:**
- Modify: `src/web/server.ts` (guard the four group-mutating routes)
- Test: `src/web/server.test.ts`

**Interfaces:**
- Consumes: `groupEditBlocked`, `__setDesktopRunningProbe` from `../desktop-groups`; existing `renderGroupsIndex`, `renderSessionDetail`, `renderLayout`.

- [ ] **Step 1: Write the failing test**

Add to `src/web/server.test.ts` inside `describe("server", ...)`:

```ts
describe("Desktop-open guard", () => {
  test("blocks group create while Desktop is running, then allows when not", async () => {
    const { __setDesktopRunningProbe } = await import("../desktop-groups");
    const app = createApp(db, syncManager);
    __setDesktopRunningProbe(() => true);
    const f1 = new FormData(); f1.append("name", "Blocked");
    const blocked = await app.request("/groups", { method: "POST", body: f1 });
    expect(blocked.status).toBe(200);
    expect(await blocked.text()).toContain("Claude Desktop is open");
    expect(db.query("SELECT id FROM groups WHERE name='Blocked'").get()).toBeNull();

    __setDesktopRunningProbe(() => false);
    const f2 = new FormData(); f2.append("name", "Allowed");
    const ok = await app.request("/groups", { method: "POST", body: f2 });
    expect(ok.status).toBe(302);
    expect(db.query("SELECT id FROM groups WHERE name='Allowed'").get()).toBeTruthy();
    __setDesktopRunningProbe(null);
  });

  test("blocks session assign while Desktop is running", async () => {
    const { __setDesktopRunningProbe } = await import("../desktop-groups");
    db.query("INSERT OR IGNORE INTO projects (id, path, display_name) VALUES ('p','/tmp/p','P')").run();
    db.query(`INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at)
              VALUES ('s1','p','/tmp/p','/tmp/s.jsonl','2026-07-10T00:00:00Z',3,datetime('now'))`).run();
    const gid = (db.query("INSERT INTO groups (name, created_at) VALUES ('G', datetime('now')) RETURNING id").get() as any).id;
    const app = createApp(db, syncManager);
    __setDesktopRunningProbe(() => true);
    const f = new FormData(); f.append("group_id", String(gid));
    const res = await app.request("/sessions/s1/group", { method: "POST", body: f });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Claude Desktop is open");
    expect(db.query("SELECT group_id FROM session_groups WHERE session_id='s1'").get()).toBeNull();
    __setDesktopRunningProbe(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/web/server.test.ts`
Expected: FAIL — edits go through while "running."

- [ ] **Step 3: Implement in `src/web/server.ts`**

3a. Add to the imports:

```ts
import { groupEditBlocked } from "../desktop-groups";
```

3b. In each of the four mutating routes — `POST /groups`, `POST /groups/:id/rename`, `POST /groups/:id/delete`, `POST /sessions/:id/group` — add a guard as the first line of the handler body. For the two that render the Groups index on error, block by re-rendering the index with the banner:

```ts
    if (groupEditBlocked()) {
      return c.html(renderLayout("Groups — Engineering Notebook", {
        body: renderGroupsIndex(db, "Claude Desktop is open — quit it before editing groups."),
        activeTab: "groups",
      }));
    }
```

For `POST /sessions/:id/group`, block by re-rendering the session view with the banner. Since `renderSessionDetail` has no error param, prepend a banner in the layout body:

```ts
    if (groupEditBlocked()) {
      const sessionId = c.req.param("id");
      const banner = `<div style="color:#b91c1c; padding:12px;">Claude Desktop is open — quit it before editing groups.</div>`;
      return c.html(renderLayout("Session — Engineering Notebook", {
        activeTab: "journal",
        panel1: renderJournalDateIndex(db, undefined),
        panel2: '<div class="empty-state">Blocked.</div>',
        panel3: banner + renderSessionDetail(db, sessionId),
      }));
    }
```

(`renderJournalDateIndex` is already imported in server.ts.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/web/server.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/server.ts src/web/server.test.ts
git commit -m "feat(desktop-import): block group edits while Claude Desktop is running"
```

---

### Task 6: Import route + button + CLI subcommand

**Files:**
- Modify: `src/web/server.ts` (add `POST /groups/import-desktop`, `GET /groups/ungrouped`)
- Modify: `src/web/views/groups.ts` (add a "Sync from Claude Desktop" button to the index)
- Modify: `src/index.ts` (add `import-desktop-groups` CLI subcommand)
- Test: `src/web/server.test.ts`

**Interfaces:**
- Consumes: `readDesktopGroups` from `../desktop-groups`; `importDesktopGroups` from `../groups`; `renderUngrouped` from `./views/groups`.

- [ ] **Step 1: Write the failing test**

Add to `src/web/server.test.ts`:

```ts
describe("Groups import + ungrouped routes", () => {
  test("GET /groups/ungrouped renders the ungrouped page", async () => {
    db.query("INSERT OR IGNORE INTO projects (id, path, display_name) VALUES ('p','/tmp/p','P')").run();
    db.query(`INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at)
              VALUES ('s1','p','/tmp/p','/tmp/s.jsonl','2026-07-10T00:00:00Z',3,datetime('now'))`).run();
    const app = createApp(db, syncManager);
    const res = await app.request("/groups/ungrouped");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Ungrouped");
  });

  test("POST /groups/import-desktop redirects to /groups", async () => {
    const app = createApp(db, syncManager);
    // No Desktop store on CI/temp env → import is a no-op but must not 500.
    const res = await app.request("/groups/import-desktop", { method: "POST", body: new FormData() });
    expect(res.status).toBe(302);
  });

  test("Groups index shows the Sync from Claude Desktop button", async () => {
    const app = createApp(db, syncManager);
    const html = await (await app.request("/groups")).text();
    expect(html).toContain("Sync from Claude Desktop");
    expect(html).toContain('action="/groups/import-desktop"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/web/server.test.ts`
Expected: FAIL — routes/button missing.

- [ ] **Step 3: Implement**

3a. `src/web/server.ts` imports:

```ts
import { readDesktopGroups } from "../desktop-groups";
import { importDesktopGroups } from "../groups";
import { renderUngrouped } from "./views/groups";
```

3b. Add routes (near the other Groups routes, before `return app;`):

```ts
  app.get("/groups/ungrouped", (c) => {
    const page = parseInt(c.req.query("page") || "1", 10);
    return c.html(renderLayout("Ungrouped — Engineering Notebook", {
      body: renderUngrouped(db, isNaN(page) ? 1 : page),
      activeTab: "groups",
    }));
  });

  app.post("/groups/import-desktop", async (c) => {
    let banner: string;
    try {
      const data = await readDesktopGroups();
      if (!data) {
        banner = "No Claude Desktop groups found.";
      } else {
        const s = importDesktopGroups(db, data);
        banner = `Imported from Desktop — +${s.groupsAdded} groups, ${s.sessionsAssigned} sessions assigned` +
          (s.skippedNoSession ? `, ${s.skippedNoSession} skipped (not ingested)` : "") +
          (s.skippedNameCollision ? `, ${s.skippedNameCollision} name-collision(s) skipped` : "") + ".";
      }
    } catch (err) {
      banner = `Import failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    return c.html(renderLayout("Groups — Engineering Notebook", {
      body: renderGroupsIndex(db, banner),
      activeTab: "groups",
    }));
  });
```

Note: `renderGroupsIndex`'s second param is styled as an error (red). That's acceptable for the summary banner in Phase 1; the reviewer may suggest a neutral variant — keep as-is unless the review requires otherwise.

3c. `src/web/views/groups.ts` — in `renderGroupsIndex`, add the button above the "New group" form:

```ts
  html += `<form action="/groups/import-desktop" method="post" style="margin-bottom:12px;">`;
  html += `<button type="submit">Sync from Claude Desktop</button>`;
  html += `</form>`;
```

3d. `src/index.ts` uses `const command = process.argv[2]; switch (command) { case "ingest": { … break; } … }`. Add a new `case` alongside the others (e.g. after `case "summarize"`), matching that style (each case reads `loadConfig()`, `initDb(config.db_path)`, and ends with `break;`):

```ts
  case "import-desktop-groups": {
    const { readDesktopGroups } = await import("./desktop-groups");
    const { importDesktopGroups } = await import("./groups");
    const config = loadConfig();
    const db = initDb(config.db_path);
    const data = await readDesktopGroups();
    if (!data) {
      console.log("No Claude Desktop groups found.");
    } else {
      const s = importDesktopGroups(db, data);
      console.log(
        `Imported: +${s.groupsAdded} groups, ${s.groupsRenamed} renamed, ${s.groupsRemoved} removed, ` +
        `${s.sessionsAssigned} sessions assigned, ${s.skippedNoSession} skipped (not ingested), ` +
        `${s.skippedNameCollision} name-collision(s).`
      );
    }
    closeDb();
    break;
  }
```

Also update the usage string at the `default` case (currently `"Usage: notebook <ingest|summarize|serve|config>"`) to include `import-desktop-groups`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/web/server.test.ts && bun run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/server.ts src/web/views/groups.ts src/index.ts src/web/views/groups.test.ts
git commit -m "feat(desktop-import): add import route, Sync button, and CLI subcommand"
```

---

### Task 7: Full suite green + live smoke check

**Files:** verification only.

- [ ] **Step 1: Full suite + typecheck**

Run: `bun run check`
Expected: all tests pass; `All checks passed.`

- [ ] **Step 2: Live smoke — real Desktop import (Desktop may be open; import reads a copy)**

```bash
engineering-notebook import-desktop-groups
```
Expected: prints a summary with `+3 groups` (Tolaria, OpenBB, Cashins Comments) and a non-zero `sessions assigned`. Record output.

- [ ] **Step 3: Live smoke — web views + guard**

```bash
engineering-notebook serve --port 3941 &
sleep 1
curl -s http://localhost:3941/groups | grep -o "Sync from Claude Desktop" | head -1
curl -s http://localhost:3941/groups | grep -oE 'Tolaria|OpenBB|Cashins Comments' | sort -u
curl -s -o /dev/null -w "ungrouped=%{http_code}\n" http://localhost:3941/groups/ungrouped
kill %1
```
Expected: button present; the three group names appear; `ungrouped=200`. If Claude Desktop is running, also confirm a group create is blocked with the banner (manual check in the browser). Record output.

- [ ] **Step 4: Commit any touch-ups (only if Steps 1-3 surfaced a fix)**

```bash
git add -A
git commit -m "chore(desktop-import): finalize Phase 1"
```

---

## Self-Review

**Spec coverage:**
- `desktop_id` column + provenance → Task 1. ✔
- Reader (snapshot copy, extract, decode, validate shape, join to cliSessionId) → Task 2. ✔
- `isClaudeDesktopRunning` + `GROUP_EDIT_POLICY`/`groupEditBlocked` → Task 2. ✔
- Import/reconcile (mirror by desktop_id, remove dropped, skip name-collision, skip missing session, manual groups untouched, idempotent) → Task 3. ✔
- Ungrouped view (paginated, recent-first, count) + index entry → Task 4. ✔
- Block guard on the four mutating routes → Task 5. ✔
- Import route + Sync button + CLI subcommand → Task 6. ✔
- Import exempt from the guard (import route never calls `groupEditBlocked`) → Task 6. ✔
- `name` UNIQUE kept; collisions skipped/reported → Tasks 1, 3. ✔
- Reader never writes to Desktop (copy only) → Task 2. ✔
- Live verification incl. real store → Tasks 2 (spike) & 7. ✔

**Placeholder scan:** No TBD/TODO; every code step has complete code; test steps show assertions. The reader's exact byte format is pinned in Global Constraints (verified against the real store), not deferred.

**Type consistency:** `DesktopGroupsData`/`DesktopGroup`/`DesktopAssignment` defined in Task 2 are consumed unchanged in Tasks 3 and 6. `ImportSummary` fields set in Task 3 match the banner/CLI strings in Task 6. `readDesktopGroups`/`importDesktopGroups`/`renderUngrouped`/`groupEditBlocked`/`__setDesktopRunningProbe` names match across Tasks 2-6. Route paths (`/groups/import-desktop`, `/groups/ungrouped`) match between Task 6 routes, the Task 4/6 view button, and the Task 6 tests.
