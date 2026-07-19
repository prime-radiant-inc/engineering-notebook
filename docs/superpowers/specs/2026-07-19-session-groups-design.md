# Session Groups — Design

**Date:** 2026-07-19
**Status:** Approved
**Scope:** Add a **Groups** view to the engineering-notebook web UI, letting the user create named headers and file individual coding sessions under them.

## Motivation

The Claude Desktop app lets a user group sessions under a named header in the sidebar. The user wants that organizing idea replicated in the notebook. Investigation established that the desktop groupings are held **server-side in the Anthropic account** and are not readable from any local file, and that the desktop "groups" (claude.ai Projects) actually organize **web-chat conversations** — a different corpus than the Claude Code / Codex **terminal transcripts** this notebook ingests.

Decision: build **manual groups over the notebook's existing coding sessions** now. Mirroring/ingesting claude.ai web chats is a separate future spec and is **out of scope here**.

## Requirements

- A **Groups** tab in the top nav: `Journal · Projects · Calendar · Groups` (Groups last).
- A group is a **named header** containing **individual sessions**.
- **One group per session** (a session is filed under at most one header, like the desktop sidebar).
- Groups are created, renamed, and deleted **in-app** (no hand-editing config files).
- A session is filed into a group via an **"Add to group"** control on the **session transcript view**.
- Group membership **persists across re-ingest** (ingest deletes/recreates session rows).

## Non-Goals (YAGNI)

- No drag-to-reorder of groups or sessions.
- No colors, icons, or descriptions on groups.
- No bulk multi-select assignment.
- No dedicated "Ungrouped" browsing page.
- No ingestion of claude.ai web chats (separate future spec).

## Data Model

Two new SQLite tables, added to the existing `CREATE TABLE IF NOT EXISTS` schema block in `src/db.ts` (no migration gymnastics needed — the schema is created idempotently on init).

```sql
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_groups (
  session_id  TEXT PRIMARY KEY,                                  -- one group per session; NO FK (see below)
  group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  assigned_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_groups_group ON session_groups(group_id);
```

**Foreign-key enforcement is ON.** `initDb` runs `PRAGMA foreign_keys = ON`. This is the constraint that shapes the schema:

- **`session_id` has NO foreign key** (deliberately). `src/ingest.ts` runs `DELETE FROM sessions WHERE id = ?` on `--force` re-ingest. If `session_id` referenced `sessions(id)`, that DELETE would be blocked by the FK (RESTRICT) and re-ingest would throw. Keeping `session_id` a bare `TEXT PRIMARY KEY` means ingest never touches membership, so it survives re-ingest. When a session is deleted and re-inserted with the same UUID, its membership row still applies.
- **`group_id` references `groups(id) ON DELETE CASCADE`.** With FK enforcement on, deleting a group automatically removes its membership rows — no manual cleanup needed.

**Cardinality:** `session_id` as PRIMARY KEY enforces one-group-per-session at the schema level. Reassigning a session is an upsert (`INSERT ... ON CONFLICT(session_id) DO UPDATE`).

**Group deletion:** `deleteGroup` is a plain `DELETE FROM groups WHERE id = ?`; the `ON DELETE CASCADE` clears memberships.

**Orphans:** a membership row whose `session_id` no longer exists (session permanently removed, not re-ingested) is harmless — all read queries `JOIN sessions`, so orphans are filtered out. Optional lazy prune is allowed but not required.

## Backend

### `src/db.ts` helpers

- `listGroups(): GroupSummary[]` — each group with `id`, `name`, `sessionCount`, `lastActivityAt` (max of member sessions' `started_at`), ordered by `lastActivityAt` desc (nulls last).
- `createGroup(name: string): number` — insert, return id; throws / surfaces error on duplicate name (UNIQUE).
- `renameGroup(id: number, name: string): void` — surfaces duplicate-name error.
- `deleteGroup(id: number): void` — `DELETE FROM groups WHERE id = ?` (cascade clears memberships).
- `assignSession(sessionId: string, groupId: number | null): void` — `null` removes membership; otherwise upsert on `session_id`.
- `getSessionGroupId(sessionId: string): number | null` — current group for rendering the control.
- `getGroupWithSessions(id: number): { group, sessions[] } | null` — group plus its member sessions (joined to `sessions` and their `projects`), ordered by `started_at` desc. Each session row carries enough to link to its transcript and, where available, its journal entry.

### `src/web/server.ts` routes (Hono, matching the existing Settings form-POST pattern)

- `GET  /groups` — index page.
- `GET  /groups/:id` — group detail; 404 if missing.
- `POST /groups` — create from form field `name`; redirect to `/groups` (or back with an error banner on duplicate/empty name).
- `POST /groups/:id/rename` — form field `name`; redirect back.
- `POST /groups/:id/delete` — redirect to `/groups`.
- `POST /sessions/:id/group` — form field `group_id` (`""` = unassign); `assignSession`; redirect back to the session view.

Validation: empty/whitespace name rejected; duplicate name reported to the user rather than throwing a 500.

## UI (`src/web/views/`)

- **`layout.ts`** — add a `Groups` nav link after `Calendar`, with a `groupsActive` flag mirroring the existing `journalActive` / `projectsActive` / `calendarActive` pattern.
- **`groups.ts` (new)** — two renders:
  - **Index:** a "New group" text input + Create button; a list of groups showing name, session count, and last activity, each linking to its detail page; inline rename (input + save) and delete (button with confirm) per group.
  - **Detail:** group name with rename/delete controls; a list of member sessions (title, date, project) linking to the existing session transcript view and journal view; empty-state text when the group has no sessions.
- **`session.ts`** — add an **"Add to group"** `<select>` (options: every group + a "None" option, current group preselected) inside a small form POSTing to `/sessions/:id/group`.

Styling reuses existing classes/tokens in `layout.ts`; no new visual system.

## Edge Cases

| Case | Behavior |
|------|----------|
| Delete a group | Member sessions become ungrouped (membership rows removed). |
| Reassign a session already in a group | Upsert replaces the prior group. |
| Assign to "None" | Membership row removed. |
| Duplicate group name (create/rename) | Rejected via UNIQUE; user sees an error, not a 500. |
| Empty/whitespace name | Rejected before insert. |
| Session removed by re-ingest | Orphan membership filtered out by `JOIN sessions`. |
| Empty group | Renders with an empty-state message. |

## Testing (TDD)

**`src/db.test.ts`**
- create → appears in `listGroups` with count 0
- assign session → count 1, appears in `getGroupWithSessions`
- reassign to another group → moves (one-group-per-session enforced)
- assign `null` → removed
- duplicate name on create and rename → errors
- delete group → memberships gone, sessions ungrouped
- **membership survives**: assign, `DELETE FROM sessions`, re-insert same id → still grouped
- orphan membership (session deleted, not re-inserted) → excluded from `getGroupWithSessions`

**`src/web/server.test.ts`**
- `GET /groups` renders; nav shows Groups active
- `POST /groups` creates; duplicate name shows error, not 500
- `POST /groups/:id/rename` and `/delete` work
- `GET /groups/:id` lists member sessions; 404 for missing id
- `POST /sessions/:id/group` files a session into a group and unassigns it

## Rollout

No new dependencies. New tables are additive and created on next `initDb`. Existing data untouched. Feature branch: `feature/session-groups`.
