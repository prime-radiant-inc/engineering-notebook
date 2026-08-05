# Weekly Status Reports — Design

**Date:** 2026-08-04
**Status:** Approved
**Scope:** Aggregate a week's journal entries into a manager-facing status report, generated from a user-editable prompt template, stored with version history and exported as markdown. Available from the CLI, a scheduled job, and both web UIs.

## Motivation

The notebook already answers "what did I do on day X" one project at a time. It cannot answer "what did I accomplish this week, and what is still open" — the question a developer or business analyst actually has to answer for their manager, every week, by hand.

The raw material already exists. Each `journal_entries` row carries a `headline`, a `summary`, a `topics` array and an `open_questions` array. What is missing is aggregation across a date range and a voice aimed at a manager rather than at the author.

The prompt is deliberately **not** hardcoded. Different managers want different things, and the person best placed to say what a status report should contain is the manager receiving it. Making the prompt an editable, shareable artifact lets a team converge on one format without anyone editing TypeScript.

## Requirements

- Aggregate **all projects with activity** in the week. No allowlist, no per-project opt-in.
- Report content: a **narrative arc**, **accomplishments**, a **per-project breakdown**, and **outstanding items**. No activity metrics.
- Outstanding items are judged by the model against the week's later entries, so work resolved mid-week is not reported as open. The report also lists what it considered **resolved this week**, so the judgement is auditable rather than opaque.
- The prompt is a **full template with placeholders**, authored by the user or their manager, **fetched from a URL** so one edit reaches a whole team.
- A week is **configurable by start day**, defaulting to ISO (Monday–Sunday).
- Every generation is a **new version**. History is retained; the latest is shown by default.
- Output is stored in the **database** and exported as a **markdown file**.
- Generation is available from the **CLI**, a **scheduled job**, and a **button in both web UIs**.

## Non-Goals (YAGNI)

- No per-project or per-audience template selection. One template.
- No emailing or posting of reports. Export a file; send it yourself.
- No activity metrics (session counts, hours). A session count is a weak proxy for output and invites bad comparisons.
- No editing of a generated report in-app. Regenerate, or edit the exported markdown.
- No cross-week trend analysis or rollups beyond a single week.

## Architecture

Four new units, each with one purpose and independently testable.

| Module | Responsibility | Depends on |
| --- | --- | --- |
| `src/week.ts` | Week label ↔ date range. Pure, no I/O. | — |
| `src/report-template.ts` | Fetch, cache and resolve the template. Owns network failure. | config |
| `src/reports.ts` | Gather entries, render, call model, parse, persist, export. | `week`, `report-template`, `llm`, db |
| `src/web/views/reports.ts` | HTMX view, generate button, job status. | `reports` |

`src/llm.ts` is reused unchanged; the `report_provider` fallback is one expression at the call site.

## Data Model

One new table, added to the existing idempotent `CREATE TABLE IF NOT EXISTS` block in `src/db.ts`.

```sql
CREATE TABLE IF NOT EXISTS weekly_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_label TEXT NOT NULL,              -- '2026-W31'
  week_start TEXT NOT NULL,              -- logical date, inclusive
  week_end TEXT NOT NULL,                -- logical date, inclusive
  version INTEGER NOT NULL,              -- 1, 2, 3 …
  markdown TEXT NOT NULL,                -- source of truth
  sections TEXT NOT NULL DEFAULT '{}',   -- best-effort '##' heading parse
  entry_ids TEXT NOT NULL DEFAULT '[]',  -- provenance
  template_source TEXT NOT NULL,         -- 'url' | 'cache' | 'default'
  model_used TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  UNIQUE(week_label, version)
);

CREATE INDEX IF NOT EXISTS idx_weekly_reports_week
  ON weekly_reports(week_label, version DESC);
```

The latest report for a week is `ORDER BY version DESC LIMIT 1`.

`markdown` is the source of truth. `sections` is a convenience extracted from `##` headings; anything built on it must tolerate it being empty, because a user-authored template is under no obligation to use headings at all.

`template_source` is recorded per report so that a week generated from a stale cache is diagnosable afterwards rather than a mystery.

## Configuration

Five optional fields. An existing install that sets none of them is unaffected.

```json
{
  "week_start_day": 1,
  "reports_dir": "~/.config/engineering-notebook/reports",
  "report_template_url": "https://example.com/weekly-template.md",
  "report_template_cache": "~/.config/engineering-notebook/report-template.cache.md",
  "report_provider": { "type": "openai", "base_url": "...", "model": "..." }
}
```

| Field | Default | Notes |
| --- | --- | --- |
| `week_start_day` | `1` (Monday) | `0` = Sunday. Changing it changes what stored week labels mean. |
| `reports_dir` | `~/.config/engineering-notebook/reports` | Markdown exports, one file per week. |
| `report_template_url` | unset | Unset means the shipped default template is used and no fetch happens. |
| `report_template_cache` | `~/.config/…/report-template.cache.md` | Written on every successful fetch. |
| `report_provider` | falls back to `summary_provider` | Same shape as `summary_provider`; lets reports use a stronger model than daily entries. |

## Template Contract

The template is markdown containing placeholders. Six are substituted:

| Placeholder | Expands to |
| --- | --- |
| `{{week_label}}` | `2026-W31` |
| `{{week_start}}` / `{{week_end}}` | Logical dates bounding the week |
| `{{entries}}` | Markdown block of the week's entries: date, project, headline, summary, topics |
| `{{open_questions}}` | Collected open items, each tagged with its date and project |
| `{{project_list}}` | Comma-separated project names with activity |

**Unknown placeholders are left untouched, not treated as errors.** A typo in a manager's template degrades one line rather than killing the run.

The shipped default template lives in `contrib/report-templates/weekly-default.md` and produces five sections: narrative, accomplishments, per-project breakdown, outstanding items, and resolved-this-week.

## CLI Surface

```sh
engineering-notebook report                    # last completed week
engineering-notebook report --week 2026-W31    # a specific week
engineering-notebook report --stdout           # print, do not store or export
```

`report` with no arguments generates for the **last completed week**, not the current one — the common case is reporting on a week that has ended. Use `--week` for the in-progress week.

`--stdout` exists for previewing a template edit without creating a version or overwriting an export. It performs the model call but writes nothing.

## Data Flow

**CLI and scheduled** — identical code; the job invokes the command.

1. Resolve week label to a logical date range via `week.ts`, honouring `week_start_day`.
2. Query `journal_entries` in range where `headline != ''`, ordered by date then project. Skip stubs are excluded, matching every existing view.
3. **No entries → no report.** Clean exit with a message; no row, no file.
4. Resolve the template, yielding prompt text and a `template_source`.
5. `complete(prompt, report_provider ?? summary_provider)`.
6. Best-effort `##` heading parse into `sections`.
7. Insert a row at `version = max(version) + 1` for that week, inside a transaction.
8. Write `reports_dir/<week_label>.md` with the latest markdown.

**Web** — generation takes 1–2 minutes, which nothing in the app currently does from the server.

- `POST /reports/generate` registers a job in an in-memory map, starts generation, returns a job id immediately.
- `GET /reports/status/:id` returns pending / done / error. HTMX polls every 2s; the React UI polls the same endpoint.
- The report is committed **before** the job is marked done, so a server restart mid-generation loses the job's status, never the report. Worst case the user refreshes and finds it already present.

## Error Handling

Every failure either produces a correct report or produces nothing. None produce a plausible-but-wrong one.

| Situation | Behaviour |
| --- | --- |
| No entries for the week | Clean exit, message, no row and no file. Not an error. |
| Fetch fails, cache exists | Use cache, record `template_source='cache'`, log it. |
| Fetch fails, no cache exists | **Error, nothing written.** Falling back to the shipped default would send a differently-shaped report under a manager's name with nobody aware. |
| Model unreachable | Error, nothing written. Matches summarize, where a failed call leaves the previous entry intact. |
| Model returns empty content | Error. `llm.ts` already throws with the reasoning-budget message. |
| Invalid week label | Error naming the expected `YYYY-Www` format. |
| Current, incomplete week | Allowed. A legitimate mid-week check-in; becomes another version. |
| `reports_dir` unwritable | Warn, do not fail. The report is already committed to the database. |
| Heading parse finds nothing | `sections = {}`. Never an error. |
| Concurrent generation | `UNIQUE(week_label, version)` turns a race into a constraint violation rather than a silent overwrite. The insert retries once, landing as the next version. |

## Testing

Test-first throughout, following the repo's existing patterns.

- **`week.ts`** — pure unit tests: ISO labels, year boundaries (W52/W53 → W01), configurable start day, label ↔ range round-tripping.
- **`report-template.ts`** — against a real local `Bun.serve` stub, as `llm.test.ts` does: successful fetch writes the cache; failure with a cache uses it; failure without a cache throws; unknown placeholders survive substitution.
- **`reports.ts`** — temp-database fixtures: range filtering, skip-stub exclusion, empty week writes nothing, version increments, heading parse over both well-formed and heading-free markdown. The model call is injected, so no test touches the network.
- **Web** — route tests for job registration and status transitions. No live model calls.
- **Manual verification before completion** — a real report generated from a real week against the live database, and a deliberately broken template URL to exercise the cache path.

## Delivery

The feature cannot ship as a single pull request to `main`, because the React button depends on the React frontend, which is unmerged (#19).

1. **Core + CLI + scheduled + HTMX button** — depends on `llm.ts` from #20. Targets `main` once #20 lands.
2. **React button** — stacked on #19, ported from the HTMX implementation.

The scheduled job follows the pattern established by `contrib/nightly-opencode/`: a script plus a launchd plist template, under `contrib/weekly-report/`.

It runs **Monday at 05:15**, generating for the week that just ended. The timing is deliberate: with `day_start_hour` at 5, the previous logical week does not close until 05:00 Monday, so an earlier run would report on an incomplete week. 05:15 also leaves the 05:05 nightly job time to finish ingesting, so the week's final day is summarized before the report reads it.

The job inherits the nightly job's known exposure: if the configured model is unreachable at that moment, the run fails, logs, and nothing retries. That is acceptable here because a report can be regenerated at any time by hand, and versioning means a later run is not a destructive correction.

## Open Questions

None. All decisions were settled during brainstorming and are recorded above.
