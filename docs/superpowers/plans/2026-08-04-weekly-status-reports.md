# Weekly Status Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aggregate a week's journal entries into a manager-facing status report, generated from a user-editable prompt template, stored with version history and exported as markdown.

**Architecture:** Four new units with clear boundaries — pure week math, template resolution (owns network failure), the generation core, and a web view. A single model call handles the whole week; the measured worst case is ~11k characters, so no chunking is needed. Markdown is the stored source of truth; a heading parse sits on top as a convenience that cannot break generation.

**Tech Stack:** Bun (runtime, test runner, `bun:sqlite`), Hono + HTMX for the web UI, the existing `src/llm.ts` provider abstraction.

## Global Constraints

- Test-first throughout. Write the failing test, watch it fail for the right reason, then implement.
- The repo gate is `bun run check` (`bun test ./src` + `tsc --noEmit`). A pre-commit hook runs it; do not bypass with `--no-verify`.
- No network in tests. Use a local `Bun.serve` stub, as `src/llm.test.ts` already does.
- Skip stubs (`journal_entries.headline = ''`) are excluded from reports, matching every existing view.
- Markdown is the source of truth. Anything derived from it must tolerate being empty.
- Config fields are all optional. An install that sets none of them must behave exactly as it does today.
- Follow existing patterns: schema goes in the idempotent `CREATE TABLE IF NOT EXISTS` block in `src/db.ts`; views live in `src/web/views/` and render through `renderLayout(title, content)`.

## Scope

This plan covers the core, CLI, scheduled job and HTMX web button. **The React button is a separate plan**, because it depends on the React frontend from unmerged PR #19 and cannot ship to `main` independently.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/week.ts` (create) | Week label ↔ date range. Pure, no I/O. |
| `src/week.test.ts` (create) | Week math tests, including year boundaries. |
| `src/report-template.ts` (create) | Fetch, cache, resolve template; substitute placeholders. |
| `src/report-template.test.ts` (create) | Fetch/cache/fallback tests against a local stub server. |
| `src/reports.ts` (create) | Gather entries, build prompt, call model, parse, persist, export. |
| `src/reports.test.ts` (create) | Generation tests with an injected model call. |
| `src/db.ts` (modify) | Add the `weekly_reports` table to the schema block. |
| `src/config.ts` (modify) | Add five optional config fields. |
| `src/index.ts` (modify) | Add the `report` CLI command. |
| `src/web/server.ts` (modify) | Register report routes. |
| `src/web/views/reports.ts` (create) | Reports page, generate button, job polling. |
| `src/web/views/layout.ts` (modify) | Add "Reports" to the nav. |
| `contrib/report-templates/weekly-default.md` (create) | Shipped default template. |
| `contrib/weekly-report/` (create) | Script + launchd plist + README. |
| `README.md` (modify) | Document the command, config and template contract. |

**Note on existing code:** `src/web/views/calendar.ts` already exports `weekMonday(dateStr)`. Task 1 supersedes it with `src/week.ts`; Task 1 Step 7 migrates the caller so week math lives in exactly one place.

---

### Task 1: Week math

**Files:**
- Create: `src/week.ts`
- Create: `src/week.test.ts`
- Modify: `src/web/views/calendar.ts` (replace local `weekMonday`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type WeekRange = { label: string; start: string; end: string }`
  - `weekRangeForLabel(label: string, startDay?: number): WeekRange`
  - `weekRangeForDate(date: string, startDay?: number): WeekRange`
  - `lastCompletedWeek(today: string, startDay?: number): WeekRange`
  - `weekMonday(date: string): string` (compatibility export for calendar.ts)
  - `startDay` defaults to `1` (Monday). Dates are `YYYY-MM-DD` strings throughout.

- [ ] **Step 1: Write the failing test**

Create `src/week.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { weekRangeForDate, weekRangeForLabel, lastCompletedWeek } from "./week";

describe("weekRangeForDate", () => {
  test("returns the ISO week containing a mid-week date", () => {
    const r = weekRangeForDate("2026-08-04"); // Tuesday
    expect(r.label).toBe("2026-W32");
    expect(r.start).toBe("2026-08-03");
    expect(r.end).toBe("2026-08-09");
  });

  test("treats Sunday as the last day of the ISO week, not the first", () => {
    const r = weekRangeForDate("2026-08-02"); // Sunday
    expect(r.label).toBe("2026-W31");
    expect(r.start).toBe("2026-07-27");
  });

  test("assigns early-January dates to a week starting in the previous year", () => {
    const r = weekRangeForDate("2026-01-01"); // Thursday
    expect(r.label).toBe("2026-W01");
    expect(r.start).toBe("2025-12-29");
    expect(r.end).toBe("2026-01-04");
  });

  test("handles a 53-week year spilling into the next", () => {
    const r = weekRangeForDate("2026-12-31");
    expect(r.label).toBe("2026-W53");
    expect(r.start).toBe("2026-12-28");
    expect(r.end).toBe("2027-01-03");
  });

  test("honours a Sunday week start", () => {
    const r = weekRangeForDate("2026-08-04", 0);
    expect(r.start).toBe("2026-08-02");
    expect(r.end).toBe("2026-08-08");
  });
});

describe("weekRangeForLabel", () => {
  test("round-trips with weekRangeForDate", () => {
    const a = weekRangeForDate("2026-08-04");
    const b = weekRangeForLabel("2026-W32");
    expect(b).toEqual(a);
  });

  test("rejects a malformed label", () => {
    expect(() => weekRangeForLabel("2026-31")).toThrow(/YYYY-Www/);
  });
});

describe("lastCompletedWeek", () => {
  test("returns the previous week, not the one in progress", () => {
    const r = lastCompletedWeek("2026-08-04"); // during W32
    expect(r.label).toBe("2026-W31");
    expect(r.end).toBe("2026-08-02");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/week.test.ts`
Expected: FAIL — `Cannot find module './week'`.

- [ ] **Step 3: Write the implementation**

Create `src/week.ts`:

```typescript
/**
 * Week math for weekly reports. Pure — no I/O, no clock access.
 *
 * Dates are `YYYY-MM-DD` strings and are treated as UTC noon internally to
 * sidestep daylight-saving edges. `startDay` is 0 (Sunday) through 6, and
 * defaults to 1 (Monday) so the default labelling matches ISO-8601.
 */

export type WeekRange = {
  /** ISO-style label, e.g. `2026-W31`. */
  label: string;
  /** First logical date of the week, inclusive. */
  start: string;
  /** Last logical date of the week, inclusive. */
  end: string;
};

const DAY_MS = 86_400_000;

function toDate(dateStr: string): Date {
  return new Date(dateStr + "T12:00:00Z");
}

function toStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function shift(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

/** Start of the week containing `date`, given a configurable first weekday. */
function weekStart(date: Date, startDay: number): Date {
  const delta = (date.getUTCDay() - startDay + 7) % 7;
  return shift(date, -delta);
}

/**
 * ISO-8601 week label. The week is numbered by the year containing its
 * Thursday, which is what makes 2026-01-01 fall in a week starting 2025-12-29.
 */
function isoLabel(start: Date): string {
  const thursday = shift(start, 3);
  const year = thursday.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1, 12));
  const week = Math.floor((thursday.getTime() - jan1.getTime()) / (7 * DAY_MS)) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export function weekRangeForDate(date: string, startDay = 1): WeekRange {
  const start = weekStart(toDate(date), startDay);
  const end = shift(start, 6);
  return { label: isoLabel(start), start: toStr(start), end: toStr(end) };
}

export function weekRangeForLabel(label: string, startDay = 1): WeekRange {
  const m = /^(\d{4})-W(\d{2})$/.exec(label);
  if (!m) throw new Error(`Invalid week label "${label}" — expected YYYY-Www, e.g. 2026-W31`);
  const year = Number(m[1]);
  const week = Number(m[2]);

  // Anchor on the Thursday of ISO week 1, then step forward whole weeks.
  const jan4 = new Date(Date.UTC(year, 0, 4, 12));
  const week1Start = weekStart(jan4, startDay);
  const start = shift(week1Start, (week - 1) * 7);
  const end = shift(start, 6);
  return { label, start: toStr(start), end: toStr(end) };
}

export function lastCompletedWeek(today: string, startDay = 1): WeekRange {
  const thisWeek = weekRangeForDate(today, startDay);
  return weekRangeForDate(toStr(shift(toDate(thisWeek.start), -1)), startDay);
}

/** Monday of the week containing `date`. Kept for calendar.ts. */
export function weekMonday(date: string): string {
  return weekRangeForDate(date, 1).start;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/week.test.ts`
Expected: PASS — 8 tests.

If `weekRangeForLabel` round-trip fails, the anchor is wrong: ISO week 1 is the week containing January 4th, not January 1st.

- [ ] **Step 5: Migrate the existing caller**

In `src/web/views/calendar.ts`, delete the local `weekMonday` function (the exported one near the top of the file) and import it instead. Add to the imports:

```typescript
import { weekMonday } from "../../week";
```

Re-export it so any other importer keeps working:

```typescript
export { weekMonday };
```

- [ ] **Step 6: Run the full gate**

Run: `bun run check`
Expected: all tests pass, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/week.ts src/week.test.ts src/web/views/calendar.ts
git commit -m "feat(week): week label and range math with configurable start day"
```

---

### Task 2: Template resolution

**Files:**
- Create: `src/report-template.ts`
- Create: `src/report-template.test.ts`
- Create: `contrib/report-templates/weekly-default.md`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `type TemplateSource = "url" | "cache" | "default"`
  - `type ResolvedTemplate = { text: string; source: TemplateSource }`
  - `resolveTemplate(opts: { url?: string; cachePath: string; fetchImpl?: typeof fetch }): Promise<ResolvedTemplate>`
  - `renderTemplate(text: string, vars: Record<string, string>): string`
  - `DEFAULT_TEMPLATE: string`

- [ ] **Step 1: Write the failing test**

Create `src/report-template.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { resolveTemplate, renderTemplate } from "./report-template";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("renderTemplate", () => {
  test("substitutes known placeholders", () => {
    const out = renderTemplate("Week {{week_label}} for {{project_list}}", {
      week_label: "2026-W31",
      project_list: "alpha, beta",
    });
    expect(out).toBe("Week 2026-W31 for alpha, beta");
  });

  test("leaves unknown placeholders untouched rather than erroring", () => {
    const out = renderTemplate("{{week_label}} {{not_a_thing}}", { week_label: "2026-W31" });
    expect(out).toBe("2026-W31 {{not_a_thing}}");
  });
});

describe("resolveTemplate", () => {
  let dir: string;
  let cachePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "en-template-"));
    cachePath = join(dir, "template.cache.md");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("uses the built-in default when no url is configured", async () => {
    const r = await resolveTemplate({ cachePath });
    expect(r.source).toBe("default");
    expect(r.text).toContain("{{entries}}");
  });

  test("fetches from the url and writes the cache", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("REMOTE {{entries}}") });
    try {
      const r = await resolveTemplate({ url: `http://localhost:${server.port}/t.md`, cachePath });
      expect(r.source).toBe("url");
      expect(r.text).toBe("REMOTE {{entries}}");
      expect(readFileSync(cachePath, "utf-8")).toBe("REMOTE {{entries}}");
    } finally {
      server.stop(true);
    }
  });

  test("falls back to the cached copy when the fetch fails", async () => {
    writeFileSync(cachePath, "CACHED {{entries}}");
    const r = await resolveTemplate({
      url: "http://localhost:1/unreachable.md",
      cachePath,
      fetchImpl: () => Promise.reject(new Error("connection refused")),
    });
    expect(r.source).toBe("cache");
    expect(r.text).toBe("CACHED {{entries}}");
  });

  test("throws when the fetch fails and no cache exists", async () => {
    expect(
      resolveTemplate({
        url: "http://localhost:1/unreachable.md",
        cachePath,
        fetchImpl: () => Promise.reject(new Error("connection refused")),
      })
    ).rejects.toThrow(/no cached copy/i);
  });

  test("treats a non-200 response as a failure", async () => {
    writeFileSync(cachePath, "CACHED");
    const server = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 500 }) });
    try {
      const r = await resolveTemplate({ url: `http://localhost:${server.port}/t.md`, cachePath });
      expect(r.source).toBe("cache");
    } finally {
      server.stop(true);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/report-template.test.ts`
Expected: FAIL — `Cannot find module './report-template'`.

- [ ] **Step 3: Write the default template**

Create `contrib/report-templates/weekly-default.md`:

```markdown
You are writing a weekly status report that a software developer sends to their
manager. Write in the first person, professionally but without corporate filler.
Aim for roughly 400 words in the narrative, with detail carried by the sections
below it.

The week is {{week_label}} ({{week_start}} to {{week_end}}).
Projects with activity: {{project_list}}

Here is every journal entry from the week:

{{entries}}

Here are the open questions raised during the week, each tagged with the date
and project it came from:

{{open_questions}}

Write the report as markdown with exactly these sections:

## Summary
A short narrative of the week — the throughline, not a list. What was the week
actually about?

## Accomplishments
What was completed and shipped. Concrete outcomes, not activity.

## By Project
A short paragraph per project that saw meaningful work. Omit trivial ones.

## Outstanding
Items still open at the end of the week. Judge this against the later entries:
if something raised on Monday was clearly resolved by Thursday, it does not
belong here.

## Resolved This Week
Open questions from the list above that later work resolved. One line each, so
the reader can see what was closed rather than dropped.

Output only the report. No preamble, no commentary about the instructions.
```

- [ ] **Step 4: Write the implementation**

Create `src/report-template.ts`:

```typescript
/**
 * Report template resolution.
 *
 * The prompt is a user-authored markdown file, optionally fetched from a URL so
 * a manager can set the format for a whole team. Every successful fetch is
 * cached; a failed fetch falls back to that cache. When a URL is configured and
 * neither the fetch nor a cache succeeds, generation fails rather than quietly
 * falling back to the shipped default — a differently-shaped report going out
 * under someone's name is worse than no report.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";

export type TemplateSource = "url" | "cache" | "default";

export type ResolvedTemplate = {
  text: string;
  source: TemplateSource;
};

/** Shipped default, used when no url is configured. */
export const DEFAULT_TEMPLATE: string = readFileSync(
  join(import.meta.dir, "../contrib/report-templates/weekly-default.md"),
  "utf-8"
);

export async function resolveTemplate(opts: {
  url?: string;
  cachePath: string;
  fetchImpl?: typeof fetch;
}): Promise<ResolvedTemplate> {
  if (!opts.url) return { text: DEFAULT_TEMPLATE, source: "default" };

  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(opts.url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const text = await res.text();
    mkdirSync(dirname(opts.cachePath), { recursive: true });
    writeFileSync(opts.cachePath, text);
    return { text, source: "url" };
  } catch (err) {
    if (existsSync(opts.cachePath)) {
      return { text: readFileSync(opts.cachePath, "utf-8"), source: "cache" };
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not fetch report template from ${opts.url} (${detail}) and no cached copy exists at ${opts.cachePath}`
    );
  }
}

/** Substitute {{name}} placeholders. Unknown placeholders are left untouched. */
export function renderTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    name in vars ? vars[name]! : whole
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test src/report-template.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 6: Run the full gate and commit**

```bash
bun run check
git add src/report-template.ts src/report-template.test.ts contrib/report-templates/weekly-default.md
git commit -m "feat(reports): template resolution with url fetch, cache fallback and default"
```

---

### Task 3: Schema and configuration

**Files:**
- Modify: `src/db.ts` (schema block)
- Modify: `src/config.ts` (add fields)
- Modify: `src/config.test.ts` (add a round-trip test)

**Interfaces:**
- Consumes: nothing.
- Produces: the `weekly_reports` table, and `Config` fields `week_start_day?: number`, `reports_dir?: string`, `report_template_url?: string`, `report_template_cache?: string`, `report_provider?: SummaryProvider`.

- [ ] **Step 1: Write the failing test**

Append to `src/config.test.ts`:

```typescript
describe("weekly report config", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "en-config-report-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("is absent by default so reports stay opt-in", () => {
    const config = loadConfig(join(tempDir, "nonexistent.json"));
    expect(config.report_template_url).toBeUndefined();
    expect(config.report_provider).toBeUndefined();
    expect(config.week_start_day).toBeUndefined();
  });

  test("round-trips the report fields", () => {
    const configPath = join(tempDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        week_start_day: 1,
        reports_dir: "~/reports",
        report_template_url: "https://example.com/t.md",
      })
    );
    const loaded = loadConfig(configPath);
    expect(loaded.week_start_day).toBe(1);
    expect(loaded.reports_dir).toBe("~/reports");
    expect(loaded.report_template_url).toBe("https://example.com/t.md");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run typecheck`
Expected: FAIL — `Property 'report_template_url' does not exist on type 'Config'`.

The runtime test may pass before the type exists, because `loadConfig` spreads unknown keys through. The typecheck is the real red here.

- [ ] **Step 3: Add the config fields**

In `src/config.ts`, add to the `Config` type after `summary_provider`:

```typescript
  /** First day of the reporting week: 0 = Sunday, 1 = Monday. Defaults to 1. */
  week_start_day?: number;
  /** Where weekly report markdown is exported. */
  reports_dir?: string;
  /** URL of the report prompt template. Unset means use the shipped default. */
  report_template_url?: string;
  /** Where the last successfully fetched template is cached. */
  report_template_cache?: string;
  /** Model for weekly reports. Falls back to summary_provider when unset. */
  report_provider?: SummaryProvider;
```

- [ ] **Step 4: Add the table**

In `src/db.ts`, inside the existing `CREATE TABLE IF NOT EXISTS` block, after the `session_groups` table:

```sql
    CREATE TABLE IF NOT EXISTS weekly_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_label TEXT NOT NULL,
      week_start TEXT NOT NULL,
      week_end TEXT NOT NULL,
      version INTEGER NOT NULL,
      markdown TEXT NOT NULL,
      sections TEXT NOT NULL DEFAULT '{}',
      entry_ids TEXT NOT NULL DEFAULT '[]',
      template_source TEXT NOT NULL,
      model_used TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      UNIQUE(week_label, version)
    );

    CREATE INDEX IF NOT EXISTS idx_weekly_reports_week
      ON weekly_reports(week_label, version DESC);
```

- [ ] **Step 5: Run the gate and commit**

```bash
bun run check
git add src/db.ts src/config.ts src/config.test.ts
git commit -m "feat(reports): weekly_reports table and report configuration"
```

---

### Task 4: Generation core

**Files:**
- Create: `src/reports.ts`
- Create: `src/reports.test.ts`

**Interfaces:**
- Consumes: `weekRangeForLabel`, `WeekRange` (Task 1); `resolveTemplate`, `renderTemplate`, `ResolvedTemplate` (Task 2); the `weekly_reports` table (Task 3); `complete`, `providerModel`, `SummaryProvider` from `src/llm.ts`.
- Produces:
  - `type ReportEntry = { id: number; date: string; project_id: string; headline: string; summary: string; topics: string; open_questions: string }`
  - `gatherEntries(db: Database, range: WeekRange): ReportEntry[]`
  - `buildVars(range: WeekRange, entries: ReportEntry[]): Record<string, string>`
  - `parseSections(markdown: string): Record<string, string>`
  - `storeReport(db, args: { range: WeekRange; markdown: string; entryIds: number[]; templateSource: string; model: string }): number` — returns the new version
  - `generateReport(db, opts: { range: WeekRange; template: ResolvedTemplate; provider?: SummaryProvider; completeImpl?: typeof complete }): Promise<{ markdown: string; version: number }>`

- [ ] **Step 1: Write the failing test**

Create `src/reports.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { gatherEntries, buildVars, parseSections, storeReport, generateReport } from "./reports";
import { weekRangeForLabel } from "./week";
import { initDb, closeDb } from "./db";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const RANGE = weekRangeForLabel("2026-W31"); // 2026-07-27 .. 2026-08-02

function seed(db: ReturnType<typeof initDb>) {
  db.exec(`
    INSERT INTO projects (id, path, display_name) VALUES ('alpha', '/p/alpha', 'Alpha');
    INSERT INTO journal_entries (date, project_id, session_ids, headline, summary, topics, open_questions, generated_at, model_used)
    VALUES
      ('2026-07-28', 'alpha', '[]', 'Shipped the parser', 'Rewrote it.', '["parser"]', '["Needs benchmarks"]', datetime('now'), 'm'),
      ('2026-08-02', 'alpha', '[]', 'Fixed the leak', 'Closed it.', '["memory"]', '[]', datetime('now'), 'm'),
      ('2026-08-05', 'alpha', '[]', 'Out of range', 'Later week.', '[]', '[]', datetime('now'), 'm'),
      ('2026-07-29', 'alpha', '[]', '', 'skip stub reason', '[]', '[]', datetime('now'), 'm');
  `);
}

describe("gatherEntries", () => {
  let dir: string;
  let db: ReturnType<typeof initDb>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "en-reports-"));
    db = initDb(join(dir, "t.db"));
    seed(db);
  });

  afterEach(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns only entries inside the week", () => {
    const rows = gatherEntries(db, RANGE);
    expect(rows.map((r) => r.date)).toEqual(["2026-07-28", "2026-08-02"]);
  });

  test("excludes skip stubs", () => {
    const rows = gatherEntries(db, RANGE);
    expect(rows.some((r) => r.headline === "")).toBe(false);
  });
});

describe("buildVars", () => {
  test("exposes the documented placeholders", () => {
    const vars = buildVars(RANGE, [
      { id: 1, date: "2026-07-28", project_id: "alpha", headline: "H", summary: "S", topics: '["t"]', open_questions: '["Q"]' },
    ]);
    expect(vars.week_label).toBe("2026-W31");
    expect(vars.week_start).toBe("2026-07-27");
    expect(vars.week_end).toBe("2026-08-02");
    expect(vars.project_list).toBe("alpha");
    expect(vars.entries).toContain("H");
    expect(vars.open_questions).toContain("Q");
  });
});

describe("parseSections", () => {
  test("extracts level-two headings", () => {
    const s = parseSections("## Summary\nprose\n\n## Outstanding\n- one\n");
    expect(s["Summary"]).toContain("prose");
    expect(s["Outstanding"]).toContain("one");
  });

  test("returns an empty object for markdown with no headings", () => {
    expect(parseSections("just prose")).toEqual({});
  });
});

describe("generateReport", () => {
  let dir: string;
  let db: ReturnType<typeof initDb>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "en-reports-gen-"));
    db = initDb(join(dir, "t.db"));
    seed(db);
  });

  afterEach(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  const template = { text: "Week {{week_label}}: {{entries}}", source: "default" as const };

  test("stores version 1 on first generation", async () => {
    const r = await generateReport(db, {
      range: RANGE,
      template,
      completeImpl: async () => "## Summary\nA good week.",
    });
    expect(r.version).toBe(1);
    expect(r.markdown).toContain("A good week.");
  });

  test("increments the version rather than overwriting", async () => {
    const opts = { range: RANGE, template, completeImpl: async () => "## Summary\nAgain." };
    await generateReport(db, opts);
    const second = await generateReport(db, opts);
    expect(second.version).toBe(2);
    const rows = db.query("SELECT COUNT(*) AS n FROM weekly_reports").get() as { n: number };
    expect(rows.n).toBe(2);
  });

  test("passes the rendered template to the model", async () => {
    let seen = "";
    await generateReport(db, {
      range: RANGE,
      template,
      completeImpl: async (prompt: string) => {
        seen = prompt;
        return "## Summary\nok";
      },
    });
    expect(seen).toContain("Week 2026-W31:");
    expect(seen).toContain("Shipped the parser");
  });

  test("writes nothing when the week has no entries", async () => {
    const empty = weekRangeForLabel("2026-W20");
    expect(
      generateReport(db, { range: empty, template, completeImpl: async () => "x" })
    ).rejects.toThrow(/no entries/i);
    const rows = db.query("SELECT COUNT(*) AS n FROM weekly_reports").get() as { n: number };
    expect(rows.n).toBe(0);
  });

  test("writes nothing when the model call fails", async () => {
    expect(
      generateReport(db, {
        range: RANGE,
        template,
        completeImpl: async () => {
          throw new Error("connection refused");
        },
      })
    ).rejects.toThrow(/connection refused/);
    const rows = db.query("SELECT COUNT(*) AS n FROM weekly_reports").get() as { n: number };
    expect(rows.n).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/reports.test.ts`
Expected: FAIL — `Cannot find module './reports'`.

- [ ] **Step 3: Write the implementation**

Create `src/reports.ts`:

```typescript
/**
 * Weekly report generation.
 *
 * A week's journal entries are rendered into a user-authored prompt template
 * and sent to the model in a single call — the busiest measured week is ~11k
 * characters, so chunking would be premature. The returned markdown is the
 * stored source of truth; the heading parse layered on top is a convenience and
 * is allowed to come back empty.
 */

import { Database } from "bun:sqlite";
import { complete, providerModel, type SummaryProvider } from "./llm";
import type { WeekRange } from "./week";
import type { ResolvedTemplate } from "./report-template";
import { renderTemplate } from "./report-template";

export type ReportEntry = {
  id: number;
  date: string;
  project_id: string;
  headline: string;
  summary: string;
  topics: string;
  open_questions: string;
};

/** Entries inside the week, skip stubs excluded, oldest first. */
export function gatherEntries(db: Database, range: WeekRange): ReportEntry[] {
  return db
    .query(
      `SELECT id, date, project_id, headline, summary, topics, open_questions
       FROM journal_entries
       WHERE date >= ? AND date <= ? AND headline != ''
       ORDER BY date, project_id`
    )
    .all(range.start, range.end) as ReportEntry[];
}

function parseJsonArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** Placeholder values for the template. Keep in sync with README. */
export function buildVars(range: WeekRange, entries: ReportEntry[]): Record<string, string> {
  const projects = [...new Set(entries.map((e) => e.project_id))];

  const entryBlock = entries
    .map((e) => {
      const topics = parseJsonArray(e.topics);
      const topicLine = topics.length ? `\nTopics: ${topics.join(", ")}` : "";
      return `### ${e.date} — ${e.project_id}\n${e.headline}\n\n${e.summary}${topicLine}`;
    })
    .join("\n\n");

  const questionBlock = entries
    .flatMap((e) => parseJsonArray(e.open_questions).map((q) => `- ${q}  _(${e.date}, ${e.project_id})_`))
    .join("\n");

  return {
    week_label: range.label,
    week_start: range.start,
    week_end: range.end,
    project_list: projects.join(", "),
    entries: entryBlock,
    open_questions: questionBlock || "_none recorded_",
  };
}

/** Best-effort split on level-two headings. Empty result is not an error. */
export function parseSections(markdown: string): Record<string, string> {
  const out: Record<string, string> = {};
  const parts = markdown.split(/^##\s+(.+)$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const heading = parts[i]!.trim();
    const body = (parts[i + 1] ?? "").trim();
    if (heading) out[heading] = body;
  }
  return out;
}

export function storeReport(
  db: Database,
  args: {
    range: WeekRange;
    markdown: string;
    entryIds: number[];
    templateSource: string;
    model: string;
  }
): number {
  const insert = db.transaction(() => {
    const row = db
      .query("SELECT COALESCE(MAX(version), 0) AS v FROM weekly_reports WHERE week_label = ?")
      .get(args.range.label) as { v: number };
    const version = row.v + 1;
    db.query(
      `INSERT INTO weekly_reports
         (week_label, week_start, week_end, version, markdown, sections, entry_ids,
          template_source, model_used, generated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).run(
      args.range.label,
      args.range.start,
      args.range.end,
      version,
      args.markdown,
      JSON.stringify(parseSections(args.markdown)),
      JSON.stringify(args.entryIds),
      args.templateSource,
      args.model
    );
    return version;
  });

  try {
    return insert();
  } catch {
    // A concurrent generation took our version number. Retry once.
    return insert();
  }
}

export async function generateReport(
  db: Database,
  opts: {
    range: WeekRange;
    template: ResolvedTemplate;
    provider?: SummaryProvider;
    completeImpl?: typeof complete;
  }
): Promise<{ markdown: string; version: number }> {
  const entries = gatherEntries(db, opts.range);
  if (entries.length === 0) {
    throw new Error(`No entries for ${opts.range.label} (${opts.range.start} to ${opts.range.end})`);
  }

  const prompt = renderTemplate(opts.template.text, buildVars(opts.range, entries));
  const run = opts.completeImpl ?? complete;
  const markdown = await run(prompt, opts.provider);

  const version = storeReport(db, {
    range: opts.range,
    markdown,
    entryIds: entries.map((e) => e.id),
    templateSource: opts.template.source,
    model: providerModel(opts.provider),
  });

  return { markdown, version };
}

/** Latest stored report for a week, or null. */
export function latestReport(
  db: Database,
  weekLabel: string
): { markdown: string; version: number; generated_at: string; template_source: string } | null {
  return db
    .query(
      `SELECT markdown, version, generated_at, template_source
       FROM weekly_reports WHERE week_label = ? ORDER BY version DESC LIMIT 1`
    )
    .get(weekLabel) as any;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/reports.test.ts`
Expected: PASS — 9 tests.

If "writes nothing when the model call fails" fails with a row present, the model call is happening after the insert. It must come first.

- [ ] **Step 5: Run the gate and commit**

```bash
bun run check
git add src/reports.ts src/reports.test.ts
git commit -m "feat(reports): weekly report generation with versioned storage"
```

---

### Task 5: CLI command and markdown export

**Files:**
- Modify: `src/index.ts` (add the `report` case)
- Modify: `src/reports.ts` (add `exportMarkdown`)
- Modify: `src/reports.test.ts` (add an export test)

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: `exportMarkdown(dir: string, weekLabel: string, markdown: string): string` — returns the written path. CLI command `report`.

- [ ] **Step 1: Write the failing test**

Append to `src/reports.test.ts`:

```typescript
describe("exportMarkdown", () => {
  test("writes one file per week and overwrites on regeneration", () => {
    const dir = mkdtempSync(join(tmpdir(), "en-export-"));
    try {
      const p1 = exportMarkdown(dir, "2026-W31", "first");
      expect(p1).toBe(join(dir, "2026-W31.md"));
      expect(readFileSync(p1, "utf-8")).toBe("first");

      const p2 = exportMarkdown(dir, "2026-W31", "second");
      expect(p2).toBe(p1);
      expect(readFileSync(p2, "utf-8")).toBe("second");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("creates the directory when missing", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "en-export-")), "nested", "reports");
    try {
      const p = exportMarkdown(dir, "2026-W31", "x");
      expect(existsSync(p)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

Add `exportMarkdown` to the import at the top of the file, and add `readFileSync, existsSync` to the `fs` import.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/reports.test.ts`
Expected: FAIL — `exportMarkdown is not a function`.

- [ ] **Step 3: Implement the export**

Add to `src/reports.ts` (and add `mkdirSync, writeFileSync` to a new `fs` import, plus `join` from `path`):

```typescript
/** Write the week's markdown to `<dir>/<week_label>.md`, returning the path. */
export function exportMarkdown(dir: string, weekLabel: string, markdown: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${weekLabel}.md`);
  writeFileSync(path, markdown);
  return path;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/reports.test.ts`
Expected: PASS — 11 tests.

- [ ] **Step 5: Add the CLI command**

In `src/index.ts`, add a new case after the `title` case:

```typescript
  case "report": {
    const config = loadConfig();
    const db = initDb(config.db_path);

    const weekIdx = process.argv.indexOf("--week");
    const weekArg = weekIdx !== -1 ? process.argv[weekIdx + 1] : undefined;
    const toStdout = process.argv.includes("--stdout");

    const { weekRangeForLabel, lastCompletedWeek } = await import("./week");
    const startDay = config.week_start_day ?? 1;
    const today = new Date().toISOString().slice(0, 10);
    const range = weekArg
      ? weekRangeForLabel(weekArg, startDay)
      : lastCompletedWeek(today, startDay);

    const { resolveTemplate } = await import("./report-template");
    const { generateReport, exportMarkdown } = await import("./reports");
    const { providerModel } = await import("./llm");

    const provider = config.report_provider ?? config.summary_provider;
    console.log(`Generating ${range.label} (${range.start} to ${range.end}) with ${providerModel(provider)}...`);

    try {
      const template = await resolveTemplate({
        url: config.report_template_url,
        cachePath: expandPath(
          config.report_template_cache ?? "~/.config/engineering-notebook/report-template.cache.md"
        ),
      });
      if (template.source === "cache") {
        console.log("  ! template URL unreachable — using the last cached copy");
      }

      if (toStdout) {
        const { gatherEntries, buildVars } = await import("./reports");
        const { renderTemplate } = await import("./report-template");
        const entries = gatherEntries(db, range);
        if (entries.length === 0) {
          console.log(`No entries for ${range.label} — nothing to report.`);
          closeDb();
          break;
        }
        const { complete } = await import("./llm");
        const markdown = await complete(renderTemplate(template.text, buildVars(range, entries)), provider);
        console.log(markdown);
        closeDb();
        break;
      }

      const result = await generateReport(db, { range, template, provider });
      const dir = expandPath(config.reports_dir ?? "~/.config/engineering-notebook/reports");
      const path = exportMarkdown(dir, range.label, result.markdown);
      console.log(`Wrote ${range.label} v${result.version} to ${path}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/^No entries for/.test(msg)) {
        console.log(`${msg} — nothing to report.`);
      } else {
        console.error(`Report failed: ${msg}`);
        process.exitCode = 1;
      }
    }

    closeDb();
    break;
  }
```

Update the usage line at the bottom of the file:

```typescript
    console.log("Usage: notebook <ingest|summarize|report|serve|config>");
```

- [ ] **Step 6: Verify the command by hand**

Run: `bun src/index.ts report --week 2026-W20`
Expected: `No entries for 2026-W20 … — nothing to report.` and exit 0.

Run: `bun src/index.ts report --week 2026-W31`
Expected: a generated report and a written path. This performs a real model call.

- [ ] **Step 7: Run the gate and commit**

```bash
bun run check
git add src/index.ts src/reports.ts src/reports.test.ts
git commit -m "feat(reports): report CLI command with markdown export"
```

---

### Task 6: Web view and generate button

**Files:**
- Create: `src/web/views/reports.ts`
- Modify: `src/web/server.ts` (register routes)
- Modify: `src/web/views/layout.ts` (nav tab)
- Create: `src/web/views/reports.test.ts`

**Interfaces:**
- Consumes: `latestReport`, `generateReport`, `exportMarkdown` (Tasks 4–5); `weekRangeForLabel`, `lastCompletedWeek` (Task 1); `resolveTemplate` (Task 2).
- Produces: `renderReports(db, weekLabel)`, `startJob(...)`, `jobStatus(id)`. Routes `GET /reports`, `POST /reports/generate`, `GET /reports/status/:id`.

- [ ] **Step 1: Write the failing test**

Create `src/web/views/reports.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { startJob, jobStatus } from "./reports";

describe("report jobs", () => {
  test("a new job starts pending and reaches done", async () => {
    const id = startJob(async () => {});
    expect(jobStatus(id)?.state).toBe("pending");
    await Bun.sleep(10);
    expect(jobStatus(id)?.state).toBe("done");
  });

  test("a failing job records the error message", async () => {
    const id = startJob(async () => {
      throw new Error("model unreachable");
    });
    await Bun.sleep(10);
    const s = jobStatus(id);
    expect(s?.state).toBe("error");
    expect(s?.error).toContain("model unreachable");
  });

  test("an unknown job id returns null", () => {
    expect(jobStatus("nope")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/web/views/reports.test.ts`
Expected: FAIL — `Cannot find module './reports'`.

- [ ] **Step 3: Write the view module**

Create `src/web/views/reports.ts`:

```typescript
import { Database } from "bun:sqlite";
import { escapeHtml } from "./helpers";
import { latestReport } from "../../reports";

export type JobState = "pending" | "done" | "error";
export type Job = { state: JobState; error?: string };

/**
 * In-memory job registry. Generation takes 1-2 minutes, which is too long for a
 * request. A restart loses job *status* but never a report: generateReport
 * commits before the job is marked done, so a lost job just means the user
 * refreshes and finds the report already there.
 */
const jobs = new Map<string, Job>();
let nextId = 1;

export function startJob(work: () => Promise<void>): string {
  const id = String(nextId++);
  jobs.set(id, { state: "pending" });
  work()
    .then(() => jobs.set(id, { state: "done" }))
    .catch((err) => jobs.set(id, { state: "error", error: err instanceof Error ? err.message : String(err) }));
  return id;
}

export function jobStatus(id: string): Job | null {
  return jobs.get(id) ?? null;
}

export function renderReports(db: Database, weekLabel: string): string {
  const report = latestReport(db, weekLabel);

  const body = report
    ? `<div class="report-meta">v${report.version} · generated ${escapeHtml(report.generated_at)} · template: ${escapeHtml(report.template_source)}</div>
       <pre class="report-markdown">${escapeHtml(report.markdown)}</pre>`
    : `<p class="empty">No report for ${escapeHtml(weekLabel)} yet.</p>`;

  return `
    <h1>Weekly Report — ${escapeHtml(weekLabel)}</h1>
    <form hx-post="/reports/generate" hx-vals='{"week": "${escapeHtml(weekLabel)}"}' hx-target="#report-status" hx-swap="innerHTML">
      <button type="submit">Generate</button>
    </form>
    <div id="report-status"></div>
    ${body}
  `;
}

/** Polling fragment returned while a job runs. */
export function renderJobStatus(id: string): string {
  const job = jobStatus(id);
  if (!job) return `<span class="error">Unknown job.</span>`;
  if (job.state === "pending") {
    return `<span hx-get="/reports/status/${id}" hx-trigger="every 2s" hx-swap="outerHTML">Generating… this takes a minute or two.</span>`;
  }
  if (job.state === "error") return `<span class="error">Failed: ${escapeHtml(job.error ?? "unknown")}</span>`;
  return `<span hx-get="/reports" hx-trigger="load" hx-target="body">Done — reloading.</span>`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/web/views/reports.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Register the routes**

In `src/web/server.ts`, after the `/calendar` route:

```typescript
  app.get("/reports", async (c) => {
    const { weekRangeForLabel, lastCompletedWeek } = await import("../week");
    const { renderReports } = await import("./views/reports");
    const { loadConfig } = await import("../config");
    const startDay = loadConfig().week_start_day ?? 1;
    const week = c.req.query("week");
    const range = week
      ? weekRangeForLabel(week, startDay)
      : lastCompletedWeek(new Date().toISOString().slice(0, 10), startDay);
    return c.html(renderLayout(`Report ${range.label}`, {
      activeTab: "reports",
      fullBody: renderReports(db, range.label),
    }));
  });

  app.post("/reports/generate", async (c) => {
    const form = await c.req.parseBody();
    const week = String(form.week ?? "");
    const { weekRangeForLabel } = await import("../week");
    const { resolveTemplate } = await import("../report-template");
    const { generateReport, exportMarkdown } = await import("../reports");
    const { loadConfig, expandPath } = await import("../config");
    const { startJob, renderJobStatus } = await import("./views/reports");

    const config = loadConfig();
    const range = weekRangeForLabel(week, config.week_start_day ?? 1);

    const id = startJob(async () => {
      const template = await resolveTemplate({
        url: config.report_template_url,
        cachePath: expandPath(config.report_template_cache ?? "~/.config/engineering-notebook/report-template.cache.md"),
      });
      const result = await generateReport(db, {
        range,
        template,
        provider: config.report_provider ?? config.summary_provider,
      });
      exportMarkdown(expandPath(config.reports_dir ?? "~/.config/engineering-notebook/reports"), range.label, result.markdown);
    });

    return c.html(renderJobStatus(id));
  });

  app.get("/reports/status/:id", async (c) => {
    const { renderJobStatus } = await import("./views/reports");
    return c.html(renderJobStatus(c.req.param("id")));
  });
```

- [ ] **Step 6: Add the nav tab**

In `src/web/views/layout.ts`, add alongside the other tab flags:

```typescript
  const reportsActive = activeTab === "reports";
```

and add the link to the nav markup next to Groups:

```html
<a href="/reports" class="${reportsActive ? "active" : ""}">Reports</a>
```

Widen the `activeTab` union type wherever it is declared to include `"reports"`.

- [ ] **Step 7: Verify by hand**

Run: `bun src/index.ts serve --port 3005`
Open `http://localhost:3005/reports`, click Generate, confirm the status polls and the report appears.

- [ ] **Step 8: Run the gate and commit**

```bash
bun run check
git add src/web/views/reports.ts src/web/views/reports.test.ts src/web/server.ts src/web/views/layout.ts
git commit -m "feat(reports): reports view with async generate button"
```

---

### Task 7: Scheduled job and documentation

**Files:**
- Create: `contrib/weekly-report/weekly-report.sh`
- Create: `contrib/weekly-report/com.engineering-notebook.weekly.plist`
- Create: `contrib/weekly-report/README.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: the `report` CLI command (Task 5).
- Produces: no code interfaces.

- [ ] **Step 1: Write the script**

Create `contrib/weekly-report/weekly-report.sh`:

```bash
#!/bin/zsh
#
# Generate the weekly status report for the week that just ended.
#
# Runs Monday at 05:15. With day_start_hour at 5 the previous logical week does
# not close until 05:00 Monday, so an earlier run would report on an incomplete
# week. 05:15 also lets a 05:05 nightly ingest finish, so the week's final day
# is summarized before the report reads it.

set -uo pipefail

[[ -f "$HOME/.zshenv" ]] && source "$HOME/.zshenv"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

REPO="${NOTEBOOK_REPO:-$HOME/Developer/engineering-notebook}"
CONFIG_DIR="${NOTEBOOK_CONFIG:-$HOME/.config/engineering-notebook}"
LOG="$CONFIG_DIR/weekly-report.log"

exec >> "$LOG" 2>&1

if [[ -f "$LOG" && $(wc -c < "$LOG") -gt 1048576 ]]; then
  tail -c 262144 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

echo "=== $(date '+%Y-%m-%d %H:%M:%S') — weekly report ==="
cd "$REPO" || { echo "FAIL: $REPO not found"; exit 1; }

# No --week: the CLI defaults to the last completed week.
bun src/index.ts report "$@"
status=$?
echo "=== done (exit $status) ==="
exit $status
```

- [ ] **Step 2: Write the plist template**

Create `contrib/weekly-report/com.engineering-notebook.weekly.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Replace __HOME__ with your home directory before installing. -->
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.engineering-notebook.weekly</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/zsh</string>
        <string>__HOME__/.config/engineering-notebook/weekly-report.sh</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Weekday</key>
        <integer>1</integer>
        <key>Hour</key>
        <integer>5</integer>
        <key>Minute</key>
        <integer>15</integer>
    </dict>
    <key>RunAtLoad</key>
    <false/>
    <key>StandardOutPath</key>
    <string>__HOME__/.config/engineering-notebook/weekly-report.launchd.log</string>
    <key>StandardErrorPath</key>
    <string>__HOME__/.config/engineering-notebook/weekly-report.launchd.log</string>
</dict>
</plist>
```

`Weekday` 1 is Monday in launchd.

- [ ] **Step 3: Write contrib/weekly-report/README.md**

```markdown
# Weekly status report (macOS / launchd)

Generates the previous week's status report every Monday at 05:15.

## Install

```sh
cp weekly-report.sh ~/.config/engineering-notebook/
chmod +x ~/.config/engineering-notebook/weekly-report.sh

sed "s|__HOME__|$HOME|g" com.engineering-notebook.weekly.plist \
  > ~/Library/LaunchAgents/com.engineering-notebook.weekly.plist

launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.engineering-notebook.weekly.plist
```

Verify, and test it the way launchd will run it:

```sh
launchctl print gui/$UID/com.engineering-notebook.weekly | grep -E '"Weekday"|"Hour"|"Minute"'
env -i HOME="$HOME" PATH=/usr/bin:/bin /bin/zsh ~/.config/engineering-notebook/weekly-report.sh --week 2026-W31
```

## Why 05:15 Monday

With `day_start_hour` at 5, the previous logical week does not close until 05:00
Monday. An earlier run reports on an incomplete week — and because reports are
versioned rather than frozen, a later re-run corrects it without losing history.

## Failure

If the configured model is unreachable the run fails, logs to
`weekly-report.log`, and nothing retries. Re-run by hand; versioning means this
is not destructive.
```

- [ ] **Step 4: Document in the main README**

Add a `### engineering-notebook report` section under Usage:

```markdown
### `engineering-notebook report`

Aggregate a week's journal entries into a status report.

```sh
engineering-notebook report                    # last completed week
engineering-notebook report --week 2026-W31    # a specific week
engineering-notebook report --stdout           # print without storing or exporting
```

Reports are stored with version history and exported to `reports_dir` as
`<week>.md`. Re-running creates a new version rather than overwriting, so the
record of what you already sent is preserved.

The prompt is a markdown template you control. Point `report_template_url` at a
file and the whole team generates reports in the same shape. Placeholders:
`{{week_label}}`, `{{week_start}}`, `{{week_end}}`, `{{entries}}`,
`{{open_questions}}`, `{{project_list}}`. Unknown placeholders are left as-is.

Every successful fetch is cached. If the URL is unreachable the cached copy is
used; if there is no cache, generation fails rather than silently falling back
to a differently-shaped default.
```

Add the five config fields to the configuration table.

- [ ] **Step 5: Verify by hand**

```bash
chmod +x contrib/weekly-report/weekly-report.sh
env -i HOME="$HOME" PATH=/usr/bin:/bin NOTEBOOK_REPO="$PWD" /bin/zsh contrib/weekly-report/weekly-report.sh --week 2026-W31
tail -20 ~/.config/engineering-notebook/weekly-report.log
```

Expected: a generated report, exit 0.

- [ ] **Step 6: Run the gate and commit**

```bash
bun run check
git add contrib/weekly-report README.md
git commit -m "contrib: weekly launchd job and report documentation"
```

---

## Deferred: React button

The React frontend lives in `web/` and arrives with PR #19, which is unmerged. A button there cannot ship to `main` independently, so it is a separate plan written once #19 lands: a `Reports` route in the React app calling the same `POST /reports/generate` and `GET /reports/status/:id` endpoints built in Task 6. No server work is needed — the endpoints are UI-agnostic by design.
