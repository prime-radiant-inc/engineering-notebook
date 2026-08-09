# Session Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a **Groups** tab to the engineering-notebook web UI where the user creates named headers and files individual coding sessions under them (one group per session).

**Architecture:** Two new SQLite tables (`groups`, `session_groups`) with a dedicated helper module `src/groups.ts`. New Hono routes in `src/web/server.ts` render a Groups index/detail view (`src/web/views/groups.ts`) and handle create/rename/delete/assign via form POSTs. An "Add to group" `<select>` is added to the existing session detail view. Membership lives in a separate table (no FK on `session_id`) so it survives `--force` re-ingest.

**Tech Stack:** Bun, `bun:sqlite`, Hono, TypeScript, server-rendered HTML strings, `bun test`.

## Global Constraints

- Runtime: **Bun** (`bun test`, `bun --bun tsc --noEmit`). No new dependencies.
- DB: `bun:sqlite` with **`PRAGMA foreign_keys = ON`** (set in `initDb`). Therefore `session_groups.session_id` MUST NOT have a foreign key (a FK would block ingest's `DELETE FROM sessions`), and `group_id` uses `REFERENCES groups(id) ON DELETE CASCADE`.
- One group per session — enforced by `session_id TEXT PRIMARY KEY`.
- All user-supplied text rendered through `escapeHtml` from `src/web/views/helpers.ts`.
- Nav order: `Journal · Projects · Calendar · Groups` (Groups last).
- Assign control lives on the **session detail view only** (`src/web/views/session.ts`).
- Follow existing patterns: inline `db.query(...)`/`db.prepare(...)`, form POST + `c.redirect(...)` like `POST /settings`, server-rendered HTML string concatenation.
- Every code change ends green: `bun test` and `bun run typecheck` both pass before each commit.
- Pre-commit hook runs `bun test` + typecheck automatically; commits fail if either fails.
- All work on branch `feature/session-groups`.

---

### Task 1: Schema — `groups` and `session_groups` tables

**Files:**
- Modify: `src/db.ts` (add two `CREATE TABLE` statements + one index inside the existing `db.exec(\`...\`)` block, after the `journal_entries` table and before the closing `` ` ``; the trailing `CREATE INDEX` lines are at the end of the same exec)
- Test: `src/db.test.ts`

**Interfaces:**
- Consumes: existing `initDb(dbPath: string): Database` from `src/db.ts`.
- Produces: tables `groups(id INTEGER PK, name TEXT UNIQUE, created_at TEXT)` and `session_groups(session_id TEXT PK, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, assigned_at TEXT)`.

- [ ] **Step 1: Write the failing test**

Add to `src/db.test.ts` inside the `describe("db", ...)` block:

```ts
test("initDb creates groups and session_groups tables", () => {
  const db = initDb(dbPath);
  const names = (
    db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
  ).map((t) => t.name);
  expect(names).toContain("groups");
  expect(names).toContain("session_groups");
});

test("session_groups.session_id has no foreign key (survives session delete)", () => {
  const db = initDb(dbPath);
  const fks = db.query("PRAGMA foreign_key_list(session_groups)").all() as { table: string }[];
  // Only group_id -> groups may exist; sessions must NOT be referenced
  expect(fks.some((f) => f.table === "sessions")).toBe(false);
  expect(fks.some((f) => f.table === "groups")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/db.test.ts`
Expected: FAIL — the two new tests fail (`groups`/`session_groups` not found).

- [ ] **Step 3: Add the tables to the schema**

In `src/db.ts`, inside the `db.exec(\`...\`)` string, immediately after the `journal_entries` `CREATE TABLE ... );` block and before the existing `CREATE INDEX IF NOT EXISTS idx_sessions_project ...` lines, insert:

```sql
    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_groups (
      session_id TEXT PRIMARY KEY,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      assigned_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_groups_group ON session_groups(group_id);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/db.test.ts`
Expected: PASS (all db tests, including the two new ones).

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat(groups): add groups and session_groups tables"
```

---

### Task 2: Group helper module — create/list/rename/delete/assign

**Files:**
- Create: `src/groups.ts`
- Test: `src/groups.test.ts`

**Interfaces:**
- Consumes: `initDb` from `src/db.ts`; a `Database` from `bun:sqlite`.
- Produces (exact signatures later tasks rely on):
  - `type GroupSummary = { id: number; name: string; sessionCount: number; lastActivityAt: string | null }`
  - `type GroupSessionRow = { id: string; display_name: string; project_id: string; started_at: string; message_count: number }`
  - `createGroup(db: Database, name: string): number` — inserts, returns new id; throws `Error("Group name already exists")` on duplicate, `Error("Group name required")` on empty/whitespace.
  - `listGroups(db: Database): GroupSummary[]` — ordered by `lastActivityAt` desc, nulls last, then name asc.
  - `renameGroup(db: Database, id: number, name: string): void` — same validation as create.
  - `deleteGroup(db: Database, id: number): void`
  - `assignSession(db: Database, sessionId: string, groupId: number | null): void` — `null` removes; else upsert.
  - `getSessionGroupId(db: Database, sessionId: string): number | null`
  - `getGroupWithSessions(db: Database, id: number): { group: { id: number; name: string }; sessions: GroupSessionRow[] } | null`

- [ ] **Step 1: Write the failing test**

Create `src/groups.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "./db";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  createGroup, listGroups, renameGroup, deleteGroup,
  assignSession, getSessionGroupId, getGroupWithSessions,
} from "./groups";

describe("groups", () => {
  let tempDir: string;
  let db: ReturnType<typeof initDb>;

  function seedProject(id = "proj-a") {
    db.query(
      "INSERT INTO projects (id, path, display_name) VALUES (?, ?, ?)"
    ).run(id, "/tmp/" + id, id);
  }
  function seedSession(id: string, projectId = "proj-a", startedAt = "2026-07-10T12:00:00Z") {
    db.query(
      `INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    ).run(id, projectId, "/tmp/" + projectId, "/tmp/src.jsonl", startedAt, 5);
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "notebook-groups-test-"));
    db = initDb(join(tempDir, "test.db"));
  });
  afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("createGroup then listGroups shows it with zero sessions", () => {
    const id = createGroup(db, "Trading");
    const groups = listGroups(db);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.id).toBe(id);
    expect(groups[0]!.name).toBe("Trading");
    expect(groups[0]!.sessionCount).toBe(0);
    expect(groups[0]!.lastActivityAt).toBeNull();
  });

  test("createGroup rejects empty and duplicate names", () => {
    createGroup(db, "Trading");
    expect(() => createGroup(db, "   ")).toThrow("Group name required");
    expect(() => createGroup(db, "Trading")).toThrow("Group name already exists");
  });

  test("assignSession files a session and updates count + lastActivity", () => {
    seedProject();
    seedSession("s1", "proj-a", "2026-07-11T09:00:00Z");
    const gid = createGroup(db, "Trading");
    assignSession(db, "s1", gid);
    expect(getSessionGroupId(db, "s1")).toBe(gid);
    const g = listGroups(db)[0]!;
    expect(g.sessionCount).toBe(1);
    expect(g.lastActivityAt).toBe("2026-07-11T09:00:00Z");
    const detail = getGroupWithSessions(db, gid)!;
    expect(detail.sessions.map((s) => s.id)).toEqual(["s1"]);
  });

  test("assignSession reassigns (one group per session)", () => {
    seedProject();
    seedSession("s1");
    const g1 = createGroup(db, "A");
    const g2 = createGroup(db, "B");
    assignSession(db, "s1", g1);
    assignSession(db, "s1", g2);
    expect(getSessionGroupId(db, "s1")).toBe(g2);
    expect(getGroupWithSessions(db, g1)!.sessions).toHaveLength(0);
    expect(getGroupWithSessions(db, g2)!.sessions).toHaveLength(1);
  });

  test("assignSession null unassigns", () => {
    seedProject();
    seedSession("s1");
    const gid = createGroup(db, "A");
    assignSession(db, "s1", gid);
    assignSession(db, "s1", null);
    expect(getSessionGroupId(db, "s1")).toBeNull();
  });

  test("renameGroup rejects duplicate name", () => {
    createGroup(db, "A");
    const b = createGroup(db, "B");
    expect(() => renameGroup(db, b, "A")).toThrow("Group name already exists");
    renameGroup(db, b, "B2");
    expect(listGroups(db).find((g) => g.id === b)!.name).toBe("B2");
  });

  test("deleteGroup removes group and its memberships (cascade)", () => {
    seedProject();
    seedSession("s1");
    const gid = createGroup(db, "A");
    assignSession(db, "s1", gid);
    deleteGroup(db, gid);
    expect(listGroups(db)).toHaveLength(0);
    expect(getSessionGroupId(db, "s1")).toBeNull();
  });

  test("membership survives session delete + re-insert (re-ingest)", () => {
    seedProject();
    seedSession("s1");
    const gid = createGroup(db, "A");
    assignSession(db, "s1", gid);
    // Simulate --force re-ingest: delete then re-insert same id
    db.query("DELETE FROM sessions WHERE id = ?").run("s1");
    seedSession("s1");
    expect(getSessionGroupId(db, "s1")).toBe(gid);
    expect(getGroupWithSessions(db, gid)!.sessions).toHaveLength(1);
  });

  test("orphan membership (deleted, not re-inserted) is filtered from detail", () => {
    seedProject();
    seedSession("s1");
    const gid = createGroup(db, "A");
    assignSession(db, "s1", gid);
    db.query("DELETE FROM sessions WHERE id = ?").run("s1");
    expect(getGroupWithSessions(db, gid)!.sessions).toHaveLength(0);
    expect(listGroups(db)[0]!.sessionCount).toBe(0);
  });

  test("getGroupWithSessions returns null for missing group", () => {
    expect(getGroupWithSessions(db, 999)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/groups.test.ts`
Expected: FAIL — `Cannot find module './groups'`.

- [ ] **Step 3: Write the implementation**

Create `src/groups.ts`:

```ts
import { Database } from "bun:sqlite";

export type GroupSummary = {
  id: number;
  name: string;
  sessionCount: number;
  lastActivityAt: string | null;
};

export type GroupSessionRow = {
  id: string;
  display_name: string;
  project_id: string;
  started_at: string;
  message_count: number;
};

function cleanName(name: string): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) throw new Error("Group name required");
  return trimmed;
}

export function createGroup(db: Database, name: string): number {
  const clean = cleanName(name);
  try {
    const row = db
      .query("INSERT INTO groups (name, created_at) VALUES (?, datetime('now')) RETURNING id")
      .get(clean) as { id: number };
    return row.id;
  } catch (err) {
    if (String(err).includes("UNIQUE")) throw new Error("Group name already exists");
    throw err;
  }
}

export function renameGroup(db: Database, id: number, name: string): void {
  const clean = cleanName(name);
  try {
    db.query("UPDATE groups SET name = ? WHERE id = ?").run(clean, id);
  } catch (err) {
    if (String(err).includes("UNIQUE")) throw new Error("Group name already exists");
    throw err;
  }
}

export function deleteGroup(db: Database, id: number): void {
  db.query("DELETE FROM groups WHERE id = ?").run(id);
}

export function listGroups(db: Database): GroupSummary[] {
  return db
    .query(
      `SELECT g.id, g.name,
              COUNT(s.id) AS sessionCount,
              MAX(s.started_at) AS lastActivityAt
       FROM groups g
       LEFT JOIN session_groups sg ON sg.group_id = g.id
       LEFT JOIN sessions s ON s.id = sg.session_id
       GROUP BY g.id
       ORDER BY (lastActivityAt IS NULL), lastActivityAt DESC, g.name ASC`
    )
    .all() as GroupSummary[];
}

export function assignSession(db: Database, sessionId: string, groupId: number | null): void {
  if (groupId === null) {
    db.query("DELETE FROM session_groups WHERE session_id = ?").run(sessionId);
    return;
  }
  db.query(
    `INSERT INTO session_groups (session_id, group_id, assigned_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(session_id) DO UPDATE SET group_id = excluded.group_id, assigned_at = excluded.assigned_at`
  ).run(sessionId, groupId);
}

export function getSessionGroupId(db: Database, sessionId: string): number | null {
  const row = db
    .query("SELECT group_id FROM session_groups WHERE session_id = ?")
    .get(sessionId) as { group_id: number } | null;
  return row ? row.group_id : null;
}

export function getGroupWithSessions(
  db: Database,
  id: number
): { group: { id: number; name: string }; sessions: GroupSessionRow[] } | null {
  const group = db.query("SELECT id, name FROM groups WHERE id = ?").get(id) as
    | { id: number; name: string }
    | null;
  if (!group) return null;
  const sessions = db
    .query(
      `SELECT s.id, p.display_name, s.project_id, s.started_at, s.message_count
       FROM session_groups sg
       JOIN sessions s ON s.id = sg.session_id
       JOIN projects p ON p.id = s.project_id
       WHERE sg.group_id = ?
       ORDER BY s.started_at DESC`
    )
    .all(id) as GroupSessionRow[];
  return { group, sessions };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/groups.test.ts`
Expected: PASS (all group helper tests).

- [ ] **Step 5: Commit**

```bash
git add src/groups.ts src/groups.test.ts
git commit -m "feat(groups): add group helper module (create/list/rename/delete/assign)"
```

---

### Task 3: Nav — add Groups tab to layout

**Files:**
- Modify: `src/web/views/layout.ts` (union types at lines 4/12/17; `activeTab` flags near line 34-36; nav block near line 708-712)
- Test: `src/web/server.test.ts` (added test added in Task 4 covers active state; this task's own check is the typecheck + a render assertion below)

**Interfaces:**
- Consumes: `renderLayout(title, content)` existing signature.
- Produces: `renderLayout` accepts `activeTab: "groups"` on the single-body content shape; nav shows a `Groups` link, highlighted when active.

- [ ] **Step 1: Write the failing test**

Add to `src/web/server.test.ts` inside `describe("server", ...)` a new nested block:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/web/server.test.ts`
Expected: FAIL — either a TypeScript error on `activeTab: "groups"` or the assertions fail (no Groups link).

- [ ] **Step 3: Implement the nav changes**

In `src/web/views/layout.ts`:

3a. Extend the `SingleContent` type (line 10-13) to allow `"groups"`:

```ts
type SingleContent = {
  body: string;
  activeTab?: "calendar" | "groups";
};
```

3b. Add a `groupsActive` flag after the `calendarActive` line (near line 36):

```ts
  const groupsActive = activeTab === "groups";
```

3c. Add the nav link after the Calendar link (near line 711):

```ts
      <a href="/calendar"${calendarActive ? ' class="active"' : ""}>Calendar</a>
      <a href="/groups"${groupsActive ? ' class="active"' : ""}>Groups</a>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/web/server.test.ts && bun run typecheck`
Expected: PASS — Groups nav test green, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/web/views/layout.ts src/web/server.test.ts
git commit -m "feat(groups): add Groups tab to nav"
```

---

### Task 4: Groups views — index and detail rendering

**Files:**
- Create: `src/web/views/groups.ts`
- Test: `src/web/views/groups.test.ts`

**Interfaces:**
- Consumes: `listGroups`, `getGroupWithSessions` from `src/groups.ts`; `escapeHtml` from `./helpers`.
- Produces:
  - `renderGroupsIndex(db: Database, error?: string): string`
  - `renderGroupDetail(db: Database, id: number): string | null` (null when the group is missing → caller returns 404)

- [ ] **Step 1: Write the failing test**

Create `src/web/views/groups.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../../db";
import { createGroup, assignSession } from "../../groups";
import { renderGroupsIndex, renderGroupDetail } from "./groups";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("groups views", () => {
  let tempDir: string;
  let db: ReturnType<typeof initDb>;

  function seed(sessionId: string) {
    db.query("INSERT OR IGNORE INTO projects (id, path, display_name) VALUES ('p','/tmp/p','My Project')").run();
    db.query(
      `INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at)
       VALUES (?, 'p', '/tmp/p', '/tmp/s.jsonl', '2026-07-10T00:00:00Z', 3, datetime('now'))`
    ).run(sessionId);
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "notebook-groupsview-test-"));
    db = initDb(join(tempDir, "test.db"));
  });
  afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("index shows create form and existing groups", () => {
    createGroup(db, "Trading");
    const html = renderGroupsIndex(db);
    expect(html).toContain('action="/groups"');
    expect(html).toContain("Trading");
    expect(html).toContain('href="/groups/');
  });

  test("index escapes group names", () => {
    createGroup(db, "<x>");
    const html = renderGroupsIndex(db);
    expect(html).toContain("&lt;x&gt;");
    expect(html).not.toContain("<x>");
  });

  test("index shows an error banner when provided", () => {
    const html = renderGroupsIndex(db, "Group name already exists");
    expect(html).toContain("Group name already exists");
  });

  test("detail lists member sessions with links", () => {
    seed("s1");
    const gid = createGroup(db, "Trading");
    assignSession(db, "s1", gid);
    const html = renderGroupDetail(db, gid)!;
    expect(html).toContain("Trading");
    expect(html).toContain("My Project");
    expect(html).toContain('href="/session/s1"');
    expect(html).toContain('action="/groups/' + gid + '/rename"');
    expect(html).toContain('action="/groups/' + gid + '/delete"');
  });

  test("detail returns null for missing group", () => {
    expect(renderGroupDetail(db, 12345)).toBeNull();
  });

  test("detail shows empty-state for a group with no sessions", () => {
    const gid = createGroup(db, "Empty");
    const html = renderGroupDetail(db, gid)!;
    expect(html).toContain("empty-state");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/web/views/groups.test.ts`
Expected: FAIL — `Cannot find module './groups'`.

- [ ] **Step 3: Write the implementation**

Create `src/web/views/groups.ts`:

```ts
import { Database } from "bun:sqlite";
import { escapeHtml } from "./helpers";
import { listGroups, getGroupWithSessions } from "../../groups";

export function renderGroupsIndex(db: Database, error?: string): string {
  const groups = listGroups(db);
  let html = `<div style="max-width: 720px; margin: 0 auto; padding: 24px;">`;
  html += `<div class="page-title">Groups</div>`;

  if (error) {
    html += `<div style="color:#b91c1c; margin-bottom:12px;">${escapeHtml(error)}</div>`;
  }

  html += `<form action="/groups" method="post" style="display:flex; gap:8px; margin-bottom:20px;">`;
  html += `<input type="text" name="name" placeholder="New group name" style="flex:1;" required>`;
  html += `<button type="submit">Create</button>`;
  html += `</form>`;

  if (groups.length === 0) {
    html += `<div class="empty-state">No groups yet. Create one above.</div>`;
  } else {
    for (const g of groups) {
      const activity = g.lastActivityAt ? g.lastActivityAt.slice(0, 10) : "—";
      html += `<div style="padding:10px 0; border-bottom:1px solid var(--border-subtle); display:flex; justify-content:space-between;">`;
      html += `<a href="/groups/${g.id}">${escapeHtml(g.name)}</a>`;
      html += `<span style="color:var(--text-ghost); font-size:12px;">${g.sessionCount} session(s) · ${activity}</span>`;
      html += `</div>`;
    }
  }

  html += `</div>`;
  return html;
}

export function renderGroupDetail(db: Database, id: number): string | null {
  const data = getGroupWithSessions(db, id);
  if (!data) return null;
  const { group, sessions } = data;

  let html = `<div style="max-width: 720px; margin: 0 auto; padding: 24px;">`;
  html += `<div style="margin-bottom:16px;"><a href="/groups">&larr; Groups</a></div>`;

  html += `<form action="/groups/${group.id}/rename" method="post" style="display:flex; gap:8px; margin-bottom:8px;">`;
  html += `<input type="text" name="name" value="${escapeHtml(group.name)}" style="flex:1; font-size:18px; font-weight:700;" required>`;
  html += `<button type="submit">Rename</button>`;
  html += `</form>`;

  html += `<form action="/groups/${group.id}/delete" method="post" style="margin-bottom:20px;" onsubmit="return confirm('Delete this group? Its sessions become ungrouped.')">`;
  html += `<button type="submit">Delete group</button>`;
  html += `</form>`;

  if (sessions.length === 0) {
    html += `<div class="empty-state">No sessions in this group yet.</div>`;
  } else {
    for (const s of sessions) {
      html += `<div style="padding:8px 0; border-bottom:1px solid var(--border-subtle);">`;
      html += `<a href="/session/${escapeHtml(s.id)}">${escapeHtml(s.display_name)}</a>`;
      html += `<div style="color:var(--text-ghost); font-size:12px;">${s.started_at.slice(0, 10)} · ${s.message_count} messages · ${escapeHtml(s.project_id)}</div>`;
      html += `</div>`;
    }
  }

  html += `</div>`;
  return html;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/web/views/groups.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/views/groups.ts src/web/views/groups.test.ts
git commit -m "feat(groups): add groups index and detail views"
```

---

### Task 5: Routes — Groups pages + create/rename/delete/assign

**Files:**
- Modify: `src/web/server.ts` (add imports near lines 3-9; add routes before `return app;` at line 277)
- Test: `src/web/server.test.ts`

**Interfaces:**
- Consumes: `renderGroupsIndex`, `renderGroupDetail` from `./views/groups`; `createGroup`, `renameGroup`, `deleteGroup`, `assignSession` from `../groups`; existing `renderLayout`.
- Produces routes: `GET /groups`, `GET /groups/:id`, `POST /groups`, `POST /groups/:id/rename`, `POST /groups/:id/delete`, `POST /sessions/:id/group`.

- [ ] **Step 1: Write the failing test**

Add to `src/web/server.test.ts` inside `describe("server", ...)`:

```ts
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/web/server.test.ts`
Expected: FAIL — routes return 404 (not defined).

- [ ] **Step 3: Implement the routes**

3a. Add imports near the other view imports (after line 8 in `src/web/server.ts`):

```ts
import { renderGroupsIndex, renderGroupDetail } from "./views/groups";
import { createGroup, renameGroup, deleteGroup, assignSession } from "../groups";
```

3b. Insert these routes immediately before `return app;` (line 277):

```ts
  // ──────────────────────────────────────────
  // Groups
  // ──────────────────────────────────────────

  app.get("/groups", (c) => {
    const error = c.req.query("error") || undefined;
    return c.html(renderLayout("Groups — Engineering Notebook", {
      body: renderGroupsIndex(db, error),
      activeTab: "groups",
    }));
  });

  app.get("/groups/:id", (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const body = isNaN(id) ? null : renderGroupDetail(db, id);
    if (!body) return c.text("Group not found", 404);
    return c.html(renderLayout("Group — Engineering Notebook", {
      body,
      activeTab: "groups",
    }));
  });

  app.post("/groups", async (c) => {
    const form = await c.req.parseBody();
    try {
      createGroup(db, (form.name as string) || "");
    } catch (err) {
      return c.html(renderLayout("Groups — Engineering Notebook", {
        body: renderGroupsIndex(db, String(err instanceof Error ? err.message : err)),
        activeTab: "groups",
      }));
    }
    return c.redirect("/groups");
  });

  app.post("/groups/:id/rename", async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const form = await c.req.parseBody();
    try {
      renameGroup(db, id, (form.name as string) || "");
    } catch (err) {
      return c.html(renderLayout("Groups — Engineering Notebook", {
        body: renderGroupsIndex(db, String(err instanceof Error ? err.message : err)),
        activeTab: "groups",
      }));
    }
    return c.redirect(`/groups/${id}`);
  });

  app.post("/groups/:id/delete", (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!isNaN(id)) deleteGroup(db, id);
    return c.redirect("/groups");
  });

  app.post("/sessions/:id/group", async (c) => {
    const sessionId = c.req.param("id");
    const form = await c.req.parseBody();
    const raw = (form.group_id as string) || "";
    const groupId = raw === "" ? null : parseInt(raw, 10);
    assignSession(db, sessionId, groupId === null || isNaN(groupId) ? null : groupId);
    return c.redirect(`/session/${encodeURIComponent(sessionId)}`);
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/web/server.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/server.ts src/web/server.test.ts
git commit -m "feat(groups): add group + session-assign routes"
```

---

### Task 6: "Add to group" control on the session view

**Files:**
- Modify: `src/web/views/session.ts` (add a select-form after the metadata header block, near line 52)
- Test: `src/web/views/session.test.ts`

**Interfaces:**
- Consumes: `listGroups`, `getSessionGroupId` from `../../groups`.
- Produces: `renderSessionDetail` output now includes an `<form action="/sessions/{id}/group">` with a `<select name="group_id">` (options: `None` + each group; current group preselected).

- [ ] **Step 1: Write the failing test**

`src/web/views/session.test.ts` already exists with a `describe("renderSessionFooter", ...)` block importing `{ describe, test, expect }` and `{ renderSessionFooter }`. **Append** to it — do not overwrite. Add the extra imports below the existing two import lines, then append the new `describe` block at the end of the file:

```ts
// add below the existing imports at the top of the file:
import { beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../../db";
import { createGroup, assignSession } from "../../groups";
import { renderSessionDetail } from "./session";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// append at the end of the file:
describe("session detail group control", () => {
  let tempDir: string;
  let db: ReturnType<typeof initDb>;

  function seed(id: string) {
    db.query("INSERT OR IGNORE INTO projects (id, path, display_name) VALUES ('p','/tmp/p','Proj')").run();
    db.query(
      `INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at)
       VALUES (?, 'p', '/tmp/p', '/tmp/s.jsonl', '2026-07-10T00:00:00Z', 3, datetime('now'))`
    ).run(id);
    db.query("INSERT INTO conversations (session_id, conversation_markdown, extracted_at) VALUES (?, '# hi', datetime('now'))").run(id);
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "notebook-sessionctl-test-"));
    db = initDb(join(tempDir, "test.db"));
  });
  afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("renders an assign form with a None option and each group", () => {
    seed("s1");
    createGroup(db, "Trading");
    createGroup(db, "Infra");
    const html = renderSessionDetail(db, "s1");
    expect(html).toContain('action="/sessions/s1/group"');
    expect(html).toContain("None");
    expect(html).toContain("Trading");
    expect(html).toContain("Infra");
  });

  test("preselects the session's current group", () => {
    seed("s1");
    const gid = createGroup(db, "Trading");
    assignSession(db, "s1", gid);
    const html = renderSessionDetail(db, "s1");
    expect(html).toMatch(new RegExp(`<option value="${gid}" selected`));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/web/views/session.test.ts`
Expected: FAIL — no assign form in output.

- [ ] **Step 3: Implement the control**

In `src/web/views/session.ts`:

3a. Add imports at the top (after line 3):

```ts
import { listGroups, getSessionGroupId } from "../../groups";
```

3b. After the metadata header `</div>` (the block that closes near line 52, right before the `if (session.conversation_markdown)` check), insert:

```ts
  const groups = listGroups(db);
  const currentGroupId = getSessionGroupId(db, sessionId);
  html += `<form action="/sessions/${escapeHtml(sessionId)}/group" method="post" style="margin-bottom:16px; display:flex; gap:8px; align-items:center;">`;
  html += `<label style="font-size:11px; color:var(--text-ghost);">Group</label>`;
  html += `<select name="group_id" onchange="this.form.submit()" style="flex:1;">`;
  html += `<option value=""${currentGroupId === null ? " selected" : ""}>None</option>`;
  for (const g of groups) {
    html += `<option value="${g.id}"${currentGroupId === g.id ? " selected" : ""}>${escapeHtml(g.name)}</option>`;
  }
  html += `</select>`;
  html += `<noscript><button type="submit">Save</button></noscript>`;
  html += `</form>`;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/web/views/session.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/views/session.ts src/web/views/session.test.ts
git commit -m "feat(groups): add 'Add to group' control to session view"
```

---

### Task 7: Full suite green + manual smoke check

**Files:**
- No new production files. Verification only.

**Interfaces:**
- Consumes: everything from Tasks 1-6.

- [ ] **Step 1: Run the whole suite + typecheck**

Run: `bun run check`
Expected: all tests pass; `All checks passed.` from typecheck.

- [ ] **Step 2: Smoke-test the running server**

Run (server on a free port, since 3000 may be occupied):

```bash
engineering-notebook serve --port 3737 &
sleep 1
curl -s -o /dev/null -w "groups=%{http_code}\n" http://localhost:3737/groups
curl -s -X POST -F "name=Smoke Test" -o /dev/null -w "create=%{http_code}\n" http://localhost:3737/groups
curl -s http://localhost:3737/groups | grep -o "Smoke Test" | head -1
kill %1
```

Expected: `groups=200`, `create=302`, and `Smoke Test` printed (group created and listed).

- [ ] **Step 3: Commit any final touch-ups (if needed)**

Only if Step 1/2 surfaced a fix. Otherwise skip.

```bash
git add -A
git commit -m "chore(groups): finalize session groups feature"
```

---

## Self-Review

**Spec coverage:**
- Groups nav tab (Groups last) → Task 3. ✔
- Named header containing individual sessions → Tasks 1, 2, 4. ✔
- One group per session (PK) → Task 1 schema + Task 2 reassign test. ✔
- In-app create/rename/delete → Tasks 4, 5. ✔
- Assign via control on session view → Task 6. ✔
- Membership survives re-ingest (no FK on session_id) → Task 1 schema + Task 2 re-ingest test. ✔
- Duplicate/empty name rejected without 500 → Task 2 (helper throws) + Task 5 (route renders error, status 200). ✔
- Ordering (groups by last activity, sessions by recency) → Task 2 queries. ✔
- Orphan membership filtered → Task 2 orphan test (JOIN sessions). ✔
- Out of scope (web chats, colors, bulk, reorder, ungrouped page) → not built. ✔

**Placeholder scan:** No TBD/TODO; every code step shows full code; every test step shows the assertions.

**Type consistency:** Helper signatures in Task 2's Interfaces (`createGroup`, `listGroups`, `renameGroup`, `deleteGroup`, `assignSession`, `getSessionGroupId`, `getGroupWithSessions`) match their use in Tasks 4, 5, 6. View function names (`renderGroupsIndex`, `renderGroupDetail`) match between Tasks 4 and 5. `activeTab: "groups"` added in Task 3 matches its use in Task 5 routes. Route paths (`/groups`, `/groups/:id`, `/groups/:id/rename`, `/groups/:id/delete`, `/sessions/:id/group`) match between Task 5 routes, Task 4 detail form actions, and Task 6 assign form.
