# Design: Persist Skipped Journal Groups (Issue #10)

## Problem

When `summarize --all` runs, session groups that Haiku classifies as
`SKIP` are not written to the database. On every subsequent run,
`groupSessionsByDateAndProject` treats those groups as unsummarised
because they are absent from `journal_entries`, and re-submits them to
Haiku. With ~44 trivial sessions, this adds ~12 minutes to what should
be an instant hourly job.

## Solution

Persist skipped groups as stub rows in `journal_entries` with
`headline = ''`. All view queries filter stubs out with
`AND je.headline != ''`. Subsequent runs see the stubs, skip the groups,
and complete instantly.

## Changes

### 1. `src/summarize.ts` — `summarizeGroup()`

When `parsed.skipped` is `true`, insert a stub row instead of returning
immediately:

- `headline = ''` — the sentinel value
- `summary = parsed.skipReason` — preserves the reason for debuggability
- `topics = '[]'`, `open_questions = '[]'`
- `session_ids`, `date`, `project_id` populated as normal

Uses the same `ON CONFLICT(date, project_id) DO UPDATE` pattern as real
entries, so re-running is idempotent.

### 2. View queries — 7 call sites

Add `AND je.headline != ''` to every query that lists or aggregates
journal entries:

| File | Purpose |
| --- | --- |
| `src/web/views/journal.ts` | Entry list (×2), latest-date query |
| `src/web/views/calendar.ts` | Gantt data, dot markers |
| `src/web/views/search.ts` | Journal entry search results |
| `src/web/views/projects.ts` | Entry list, most-recent-entry lookup |

The by-ID fetches in `server.ts` and `journal.ts` do not need the filter
— stubs are unreachable via UI navigation once the listing queries
exclude them.

### 3. Tests — `tests/summarize.test.ts`

Add a test verifying that when `summarizeGroup` receives a `SKIP`
response:

- A stub row is inserted into `journal_entries`
- The row has `headline = ''`
- The row has `summary` equal to the skip reason
- A second call with the same group is idempotent (no error, row
  unchanged)

## No Schema Migration Required

`journal_entries` already has `headline TEXT NOT NULL DEFAULT ''`, so
stub rows are valid without any schema change.

## Constraints

- The `headline != ''` sentinel is consistent with the existing default
  (`DEFAULT ''`) in the schema.
- Skipped stubs are invisible to all UI surfaces once the filter is
  applied — they exist only to short-circuit re-evaluation.
- The fix is fully backwards-compatible; existing databases need no
  migration.
