# Desktop Group Import (Phase 1) — Design

**Date:** 2026-07-19
**Status:** Approved
**Builds on:** `2026-07-19-session-groups-design.md` (the manual Session Groups feature)
**Branch:** `feature/session-groups`

## Motivation

The manual Session Groups feature ships an empty Groups tab: the user must create every group by hand. But the user already has real groups in the **Claude Desktop** app — "Tolaria", "OpenBB", "Cashins Comments" — each with sessions filed under it. They expected those to appear in the notebook automatically, with every other session shown as **Ungrouped**.

Investigation established that the Desktop groups **are** readable from local disk (an earlier "not readable" conclusion was wrong — the search looked for the word "group" instead of the actual group names). They live in the Claude Desktop app's Chromium LocalStorage under the key **`dframe-group-scopes`**, and each Desktop session joins to a notebook session via a two-hop mapping that was verified end-to-end.

This is **Phase 1**: one-way import (Desktop → notebook) plus an Ungrouped view and a guard. **Phase 2** (write-back, notebook → Desktop) is a separate future spec and is out of scope here.

## Data Source (verified)

- **File:** `~/Library/Application Support/Claude/Local Storage/leveldb/` (Chromium LevelDB-backed LocalStorage for origin `https://claude.ai`).
- **Key:** `dframe-group-scopes`. Its value is a JSON object holding:
  - a **groups** array — objects with a group id (e.g. `g-4a1f3ce4-49ab-42d2-a2da-ec04dba4e9bd`) and a `name` ("Tolaria", "OpenBB", "Cashins Comments");
  - an **assignments** map — Desktop-session-id → group-id.
  - (Exact top-level field names and value encoding are pinned by the reader spike, Task 1 of the plan.)
- **Join to the notebook (verified):** a Desktop assignment key is a Desktop session id matching a file `~/Library/Application Support/Claude/claude-code-sessions/<account>/<workspace>/local_<id>.json`; that file's `cliSessionId` equals the notebook's `sessions.id`. Confirmed: assignment `bb6b56ef-…` → `local_bb6b56ef-…json` → `cliSessionId d73396da-…` → notebook session `d73396da-…`.

## Requirements

- A **"Sync from Claude Desktop"** action (Groups-page button + an `import-desktop-groups` CLI subcommand) that imports Desktop groups and their session assignments into the notebook.
- Imported groups are tagged with their Desktop group id; re-sync is idempotent and **mirrors Desktop** for imported groups (adds/renames/removes to track Desktop), while leaving **notebook-created groups untouched**.
- An **Ungrouped** view listing all sessions with no group.
- The existing manual create/rename/delete/assign controls stay.
- A **Desktop-open guard**: while Claude Desktop is running, group-mutating actions (create/rename/delete group, assign/unassign session) are **blocked** with an explanatory banner. The import action is exempt. The block/warn behavior is a single policy switch (this phase = block; future = warn).

## Non-Goals (Phase 2 / out of scope)

- Write-back to Desktop (notebook → `dframe-group-scopes`).
- Flipping the guard from block to warn-and-allow.
- Assigning notebook sessions that Desktop has never seen (no `local_*.json`) — not representable in Desktop, irrelevant for one-way import.

## Data Model

Extend the existing `groups` table (created in the manual-groups feature):

```sql
ALTER TABLE groups ADD COLUMN desktop_id TEXT;   -- Desktop group id; NULL for notebook-created groups
CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_desktop_id ON groups(desktop_id) WHERE desktop_id IS NOT NULL;
```

- Added idempotently via the existing try/catch `ALTER TABLE` migration pattern in `initDb`, plus the partial unique index in the schema block (partial so multiple manual groups can share `NULL`).
- `session_groups` unchanged. Provenance of a group is `desktop_id IS NOT NULL`.

## Components

### 1. Desktop reader — `src/desktop-groups.ts`
- `readDesktopGroups(opts?): { groups: {desktopId: string; name: string}[]; assignments: {cliSessionId: string; desktopGroupId: string}[] } | null`
- Steps: locate the leveldb dir → **copy it to a temp dir** (snapshot; safe while Desktop holds the write-lock) → extract the `dframe-group-scopes` value → decode JSON → validate shape (return `null` / throw a typed error if unrecognized, so a future Desktop format change fails safe rather than corrupting notebook state) → build the `desktopSessionId → cliSessionId` map by scanning `claude-code-sessions/**/local_*.json` → return Desktop groups plus assignments already resolved to `cliSessionId`.
- **Key risk / first task:** reliable extraction from the Chromium LevelDB (the value currently lives in a compacted `.ldb` sstable, and may be Snappy-compressed; the WAL path must also be handled). Task 1 is a spike with a test against the real store, iterating until it decodes. Prefer a dependency-free reader; a small vetted LevelDB/Snappy dependency is permitted only if dependency-free proves unreliable.
- Path override via option/env so tests run against a fixture copy rather than the live machine store.

### 2. Import / reconcile — `src/groups.ts`
- `importDesktopGroups(db, source): { groupsAdded; groupsRenamed; groupsRemoved; sessionsAssigned; sessionsUnassigned; skipped }` where `source` is the reader's output (injected, so tests don't touch the real store).
- Reconcile:
  - Upsert each Desktop group by `desktop_id` (create if new; rename if `name` changed).
  - For each Desktop group, set its membership to exactly Desktop's assignment set whose `cliSessionId` exists in `sessions`: assign new ones (upsert on `session_id`), and remove sessions currently in that Desktop group but no longer assigned in Desktop. Assignments whose `cliSessionId` isn't in the notebook are counted as `skipped`.
  - Delete `desktop_id` groups that no longer exist in Desktop (cascade clears their memberships).
  - Groups with `desktop_id IS NULL` (notebook-created) and their memberships are never read or written by import.

### 3. Ungrouped view — `src/web/views/groups.ts`
- The Groups index gains an **"Ungrouped (N)"** entry linking to `/groups/ungrouped`.
- `renderUngrouped(db, page)` lists sessions with no `session_groups` row, ordered by `started_at` desc, paginated (100/page) with an "N of M" count and prev/next links; each row links to `/session/:id`.

### 4. Desktop-open guard — `src/desktop-groups.ts` + `src/web/server.ts`
- `isClaudeDesktopRunning(): boolean` — process check via `pgrep` for the Claude Desktop binary. Returns false on error (fail-open on detection failure so the notebook is never wedged by a detection bug).
- A single `GROUP_EDIT_POLICY` constant (`"block" | "warn"`, this phase `"block"`) and a helper `guardGroupEdit()` used by the four mutating routes (`POST /groups`, `/groups/:id/rename`, `/groups/:id/delete`, `/sessions/:id/group`). When policy is `block` and Desktop is running: skip the mutation and re-render the page (Groups index or session view) with a banner "Claude Desktop is open — quit it before editing groups." (HTTP 200). Import routes do not call the guard.
- The guard's "is Desktop running" check is injectable in tests (parameter/override) so tests don't depend on the real process table.

### 5. Routes & CLI — `src/web/server.ts`, `src/index.ts`
- `POST /groups/import-desktop` — runs the reader + `importDesktopGroups`, redirects to `/groups` (with a summary/error banner). Not guarded.
- `GET /groups/ungrouped` — paginated Ungrouped page (`?page=`).
- A "Sync from Claude Desktop" button on the Groups index posts to `/groups/import-desktop`.
- CLI: `engineering-notebook import-desktop-groups` runs the same import and prints the summary.

## Edge Cases

| Case | Behavior |
|------|----------|
| Desktop store missing / key absent | Reader returns null; import reports "No Claude Desktop groups found," no changes. |
| `dframe-group-scopes` shape unrecognized (Desktop update) | Reader throws typed error; import aborts with a clear message; notebook state untouched. |
| Desktop assignment → session not in notebook | Counted as `skipped`; not assigned. |
| Desktop group deleted since last import | Its `desktop_id` group + memberships removed on re-sync. |
| Session manually moved off an imported group, then re-sync | Snaps back to Desktop's assignment (imported groups mirror Desktop). |
| Desktop group name collides with an existing differently-identified group (manual group, or already-imported different `desktop_id`) | The colliding Desktop group is **skipped** and reported in the summary; `groups.name` UNIQUE is kept (see Risk). Non-colliding groups still import. |
| Desktop running during a manual edit | Blocked with banner (policy = block). |
| Desktop running during import | Allowed (reads a snapshot copy). |

## Risks

- **`groups.name` UNIQUE constraint.** The base feature made `name` UNIQUE. We **keep** it — dropping it in SQLite forces a full `groups` table rebuild, which is risky given `session_groups.group_id`'s cascading FK. Instead, import matches groups by `desktop_id`; if a Desktop group's name collides with an existing group of different identity, that one group is skipped and reported, and the rest still import. This is simpler and lower-risk than a rebuild, at the cost of not allowing a manual and a Desktop group to share a name (acceptable — the user currently has no manual groups, and the collision is rare and clearly reported).
- **LevelDB/sstable reading** is the primary technical risk (Task 1 spike).
- **Undocumented Desktop format** — mitigated by shape validation that fails safe.
- **Snapshot copy while Desktop writes** — may yield a momentarily torn read; acceptable (re-run sync).

## Testing

- **Reader:** decodes a committed fixture copy of a leveldb store into the expected groups + assignments; shape-validation rejects malformed input; missing store → null.
- **Import/reconcile:** creates/renames/removes Desktop groups; propagates membership add + remove; leaves manual groups untouched; idempotent on re-run; counts skipped (session-not-in-notebook).
- **Join:** `local_*.json` → `cliSessionId` mapping across a fixture.
- **Ungrouped:** correct membership-free set, ordering, pagination + counts.
- **Guard:** mutation blocked when "running," allowed when not (running-check injected); import never blocked.
- **Migration:** adding `desktop_id` + partial unique index preserves existing rows; existing manual-groups tests still pass; a name-colliding Desktop group is skipped and reported.

## Rollout

Additive column + index and new module; no data loss. New CLI subcommand and routes. Reader touches only a temp **copy** of the Desktop store — never writes to Desktop in Phase 1.
