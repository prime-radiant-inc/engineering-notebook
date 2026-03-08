# Persist Skipped Journal Groups — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement
> this plan task-by-task.

**Goal:** Stop skipped session groups from being re-evaluated by Haiku on every
run by persisting stub rows in `journal_entries`.

**Architecture:** Extract the `journal_entries` upsert logic from `summarizeGroup`
into a testable `upsertJournalEntry` helper. When the LLM returns SKIP, the helper
inserts a stub with `headline = ''` and the skip reason in `summary`. All view
queries gain `AND je.headline != ''` to hide stubs from the UI.

**Tech Stack:** Bun, SQLite (`bun:sqlite`), TypeScript. Tests use Bun's built-in
test runner (`bun test`).

---

### Task 1: Write the failing test

**Files:**

- Create: `tests/summarize.test.ts`

The project has no test files yet (only fixtures). We will use Bun's built-in
test runner. No install needed.

**Step 1: Create the test file**

```typescript
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initDb } from "../src/db";
import { upsertJournalEntry } from "../src/summarize";
import type { SessionGroup } from "../src/summarize";

function makeTestDb(): Database {
  // ":memory:" gives a fresh in-memory SQLite DB each call
  return initDb(":memory:");
}

const group: SessionGroup = {
  date: "2026-01-15",
  projectId: "my-project",
  projectName: "My Project",
  sessionIds: ["session-abc"],
  conversations: ["some transcript"],
};

describe("upsertJournalEntry", () => {
  let db: Database;

  beforeEach(() => {
    db = makeTestDb();
    // Insert the project row required by the foreign key
    db.prepare(
      `INSERT INTO projects (id, path, display_name) VALUES (?, ?, ?)`
    ).run("my-project", "/path/to/project", "My Project");
  });

  test("inserts a stub row when result is skipped", () => {
    upsertJournalEntry(db, group, {
      skipped: true,
      skipReason: "automated test run, no problem-solving",
    });

    const row = db
      .query(`SELECT headline, summary FROM journal_entries WHERE date = ? AND project_id = ?`)
      .get("2026-01-15", "my-project") as { headline: string; summary: string } | null;

    expect(row).not.toBeNull();
    expect(row!.headline).toBe("");
    expect(row!.summary).toBe("automated test run, no problem-solving");
  });

  test("stub insertion is idempotent", () => {
    const skipped = { skipped: true as const, skipReason: "trivial" };
    upsertJournalEntry(db, group, skipped);
    // Second call must not throw
    upsertJournalEntry(db, group, skipped);

    const count = db
      .query(`SELECT COUNT(*) as n FROM journal_entries WHERE date = ? AND project_id = ?`)
      .get("2026-01-15", "my-project") as { n: number };
    expect(count.n).toBe(1);
  });

  test("inserts a real entry when result is not skipped", () => {
    upsertJournalEntry(db, group, {
      skipped: false,
      headline: "Shipped the thing",
      summary: "We shipped it.",
      topics: ["shipping"],
      openQuestions: [],
    });

    const row = db
      .query(`SELECT headline FROM journal_entries WHERE date = ? AND project_id = ?`)
      .get("2026-01-15", "my-project") as { headline: string } | null;

    expect(row).not.toBeNull();
    expect(row!.headline).toBe("Shipped the thing");
  });
});
```

**Step 2: Run the test to confirm it fails**

```bash
bun test tests/summarize.test.ts
```

Expected: error — `upsertJournalEntry` is not exported from `src/summarize`.

---

### Task 2: Extract `upsertJournalEntry` and persist skipped stubs

**Files:**

- Modify: `src/summarize.ts`

**Step 1: Export `upsertJournalEntry` and call it from `summarizeGroup`**

Replace the inline `db.prepare(...)` block inside `summarizeGroup` (lines 380–401)
and the `return { skipped: true }` early-return (line 377) with a call to the new
exported helper.

New exported function to add above `summarizeGroup`:

```typescript
export function upsertJournalEntry(
  db: Database,
  group: SessionGroup,
  result: SummaryResult
): void {
  if (result.skipped) {
    db.prepare(
      `
      INSERT INTO journal_entries
        (date, project_id, session_ids, headline, summary, topics, open_questions, generated_at, model_used)
      VALUES (?, ?, ?, '', ?, '[]', '[]', datetime('now'), ?)
      ON CONFLICT(date, project_id) DO UPDATE SET
        session_ids = excluded.session_ids,
        generated_at = excluded.generated_at
      `
    ).run(
      group.date,
      group.projectId,
      JSON.stringify(group.sessionIds),
      result.skipReason,
      SUMMARIZE_MODEL
    );
    return;
  }

  db.prepare(
    `
    INSERT INTO journal_entries
      (date, project_id, session_ids, headline, summary, topics, open_questions, generated_at, model_used)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
    ON CONFLICT(date, project_id) DO UPDATE SET
      headline = excluded.headline,
      summary = excluded.summary,
      topics = excluded.topics,
      open_questions = excluded.open_questions,
      generated_at = excluded.generated_at,
      session_ids = excluded.session_ids
    `
  ).run(
    group.date,
    group.projectId,
    JSON.stringify(group.sessionIds),
    result.headline,
    result.summary,
    JSON.stringify(result.topics),
    JSON.stringify(result.openQuestions),
    SUMMARIZE_MODEL
  );
}
```

Then in `summarizeGroup`, replace the entire `if (parsed.skipped) { return ... }` block
and the `db.prepare(...)` block with a single call:

```typescript
upsertJournalEntry(db, group, parsed);
return { skipped: parsed.skipped, skipReason: parsed.skipped ? parsed.skipReason : undefined };
```

**Step 2: Run the tests to verify they pass**

```bash
bun test tests/summarize.test.ts
```

Expected: all 3 tests pass.

**Step 3: Commit**

```bash
git add src/summarize.ts tests/summarize.test.ts
git commit -m "fix: persist skipped journal groups as stub rows to prevent re-evaluation"
```

---

### Task 3: Filter stubs from `journal.ts` view queries

**Files:**

- Modify: `src/web/views/journal.ts`

There are three queries to update.

**Step 1: `renderJournalDateIndex` — date index query (line ~27)**

Add `AND je.headline != ''` before `GROUP BY`:

```sql
SELECT je.date, GROUP_CONCAT(DISTINCT p.display_name) as projects
FROM journal_entries je
JOIN projects p ON je.project_id = p.id
WHERE je.headline != ''
GROUP BY je.date
ORDER BY je.date DESC
```

**Step 2: `renderJournalEntries` — entries-for-date query (line ~63)**

Add `AND je.headline != ''` to the WHERE clause:

```sql
SELECT je.id, je.date, je.project_id, p.display_name, je.headline,
       je.summary, je.topics, je.session_ids, je.open_questions
FROM journal_entries je
JOIN projects p ON je.project_id = p.id
WHERE je.date = ? AND je.headline != ''
ORDER BY p.display_name
```

**Step 3: `renderJournalPage` — latest-date fallback query (line ~138)**

```sql
SELECT date FROM journal_entries WHERE headline != '' ORDER BY date DESC LIMIT 1
```

**Step 4: Commit**

```bash
git add src/web/views/journal.ts
git commit -m "fix: exclude skipped stub entries from journal view queries"
```

---

### Task 4: Filter stubs from `calendar.ts` view queries

**Files:**

- Modify: `src/web/views/calendar.ts`

Two queries to update. Both already have a `WHERE` clause via the `ex.sql` helper.

**Step 1: Gantt entries query (line ~73)**

Add `AND je.headline != ''` to the WHERE clause:

```sql
SELECT je.date, je.project_id, p.display_name, je.headline, je.id as entry_id
FROM journal_entries je
JOIN projects p ON je.project_id = p.id
WHERE je.date BETWEEN ? AND ?
  AND je.headline != ''
  ${ex.sql.replace(/\bid\b/g, "p.id")}
ORDER BY je.date, p.display_name
```

**Step 2: iCal feed query (line ~289)**

Add `AND je.headline != ''` to the WHERE clause:

```sql
SELECT je.id, je.date, je.headline, je.summary, je.generated_at, p.display_name
FROM journal_entries je
JOIN projects p ON je.project_id = p.id
WHERE je.headline != ''${ex.sql.replace(/\bid\b/g, "p.id")}
ORDER BY je.date DESC
```

**Step 3: Commit**

```bash
git add src/web/views/calendar.ts
git commit -m "fix: exclude skipped stub entries from calendar and iCal queries"
```

---

### Task 5: Filter stubs from `search.ts` and `projects.ts` queries

**Files:**

- Modify: `src/web/views/search.ts`
- Modify: `src/web/views/projects.ts`

**Step 1: `search.ts` — journal results query (line ~20)**

Add `AND je.headline != ''` to the WHERE clause:

```sql
SELECT je.id, je.date, je.project_id, p.display_name, je.headline, je.summary, je.topics
FROM journal_entries je
JOIN projects p ON je.project_id = p.id
WHERE (je.summary LIKE ? OR je.topics LIKE ? OR je.headline LIKE ?)
  AND je.headline != ''
ORDER BY je.date DESC
LIMIT 20
```

**Step 2: `projects.ts` — project timeline entries query (line ~111)**

Add `AND je.headline != ''` to the WHERE clause:

```sql
SELECT je.id, je.date, je.headline, je.summary, je.topics, je.session_ids, je.open_questions
FROM journal_entries je
WHERE je.project_id = ? AND je.headline != ''
ORDER BY je.date DESC
```

**Step 3: `projects.ts` — most-recent-entry default query (line ~196)**

```sql
SELECT id FROM journal_entries
WHERE project_id = ? AND headline != ''
ORDER BY date DESC LIMIT 1
```

**Step 4: Commit**

```bash
git add src/web/views/search.ts src/web/views/projects.ts
git commit -m "fix: exclude skipped stub entries from search and projects view queries"
```

---

### Task 6: Run full test suite and verify

```bash
bun test
```

Expected: all tests pass with no errors.

If tests pass, push the branch:

```bash
git push
```
