import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "./db";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  weekStart,
  formatWeekRange,
  getDailyEntriesForWeek,
  buildWeeklyRollupPrompt,
  findUnrolledWeeks,
} from "./rollup";

describe("weekStart", () => {
  test("returns Monday for a Monday", () => {
    expect(weekStart("2026-05-11")).toBe("2026-05-11");
  });

  test("returns Monday for a Wednesday", () => {
    expect(weekStart("2026-05-13")).toBe("2026-05-11");
  });

  test("returns Monday for a Sunday (wraps to previous week)", () => {
    expect(weekStart("2026-05-17")).toBe("2026-05-11");
  });

  test("crosses month boundaries", () => {
    // 2026-06-01 is a Monday
    expect(weekStart("2026-06-03")).toBe("2026-06-01");
    // 2026-06-02 is a Tuesday; Monday is 2026-06-01
    expect(weekStart("2026-05-31")).toBe("2026-05-25");
  });
});

describe("formatWeekRange", () => {
  test("formats a single-month range", () => {
    const result = formatWeekRange("2026-05-11");
    expect(result).toContain("May");
    expect(result).toContain("2026");
  });

  test("formats a month-crossing range", () => {
    const result = formatWeekRange("2026-04-27");
    expect(result).toContain("Apr");
    expect(result).toContain("May");
  });
});

describe("getDailyEntriesForWeek / buildWeeklyRollupPrompt", () => {
  let tempDir: string;
  let db: ReturnType<typeof initDb>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "notebook-rollup-test-"));
    db = initDb(join(tempDir, "test.db"));
    db.exec(`INSERT INTO projects (id, path, display_name) VALUES ('myapp', '/p', 'myapp')`);
  });

  afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function plantEntry(date: string, headline: string, summary: string, topics: string[] = [], oq: string[] = []) {
    db.exec(`
      INSERT INTO journal_entries (date, project_id, session_ids, headline, summary, topics, open_questions, generated_at, model_used)
      VALUES ('${date}', 'myapp', '[]', ${q(headline)}, ${q(summary)}, ${q(JSON.stringify(topics))}, ${q(JSON.stringify(oq))}, datetime('now'), 'test')
    `);
  }
  function q(s: string): string {
    return `'${s.replace(/'/g, "''")}'`;
  }

  test("getDailyEntriesForWeek picks up Monday-through-Sunday", () => {
    // Week of 2026-05-11 (Mon) – 2026-05-17 (Sun)
    plantEntry("2026-05-11", "Monday work", "summary-mon");
    plantEntry("2026-05-13", "Wednesday work", "summary-wed");
    plantEntry("2026-05-17", "Sunday work", "summary-sun");
    plantEntry("2026-05-18", "next week", "should-not-appear"); // next week

    const entries = getDailyEntriesForWeek(db, "myapp", "2026-05-11");
    expect(entries.length).toBe(3);
    expect(entries.map((e) => e.date)).toEqual([
      "2026-05-11",
      "2026-05-13",
      "2026-05-17",
    ]);
  });

  test("getDailyEntriesForWeek marks empty-headline entries as skips", () => {
    plantEntry("2026-05-11", "Real work", "summary");
    plantEntry("2026-05-12", "", "Skipped: just status checks");

    const entries = getDailyEntriesForWeek(db, "myapp", "2026-05-11");
    expect(entries[0]!.isSkip).toBe(false);
    expect(entries[1]!.isSkip).toBe(true);
  });

  test("buildWeeklyRollupPrompt includes real and skipped entries in different sections", () => {
    plantEntry("2026-05-11", "Built X", "Got X shipped to staging.", ["X"], ["Need to monitor X"]);
    plantEntry("2026-05-12", "", "Only status checks today.");
    const entries = getDailyEntriesForWeek(db, "myapp", "2026-05-11");

    const prompt = buildWeeklyRollupPrompt("myapp", "2026-05-11", entries);
    expect(prompt).toContain("Project: myapp");
    expect(prompt).toContain("### 2026-05-11");
    expect(prompt).toContain("Built X");
    expect(prompt).toContain("skipped at the daily level");
    expect(prompt).toContain("Only status checks today");
  });

});

describe("findUnrolledWeeks", () => {
  let tempDir: string;
  let db: ReturnType<typeof initDb>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "notebook-rollup-find-"));
    db = initDb(join(tempDir, "test.db"));
    db.exec(`INSERT INTO projects (id, path, display_name) VALUES ('p1', '/p1', 'p1')`);
    db.exec(`INSERT INTO projects (id, path, display_name) VALUES ('p2', '/p2', 'p2')`);
  });

  afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns one tuple per (week, project) with daily entries", () => {
    db.exec(`
      INSERT INTO journal_entries (date, project_id, session_ids, headline, summary, generated_at, model_used)
      VALUES
        ('2026-05-11', 'p1', '[]', 'h1', 's1', datetime('now'), 't'),
        ('2026-05-13', 'p1', '[]', 'h2', 's2', datetime('now'), 't'),
        ('2026-05-12', 'p2', '[]', 'h3', 's3', datetime('now'), 't'),
        ('2026-05-19', 'p1', '[]', 'h4', 's4', datetime('now'), 't')
    `);

    const unrolled = findUnrolledWeeks(db);
    expect(unrolled.length).toBe(3); // (week-of-05-11, p1), (week-of-05-11, p2), (week-of-05-18, p1)
    expect(unrolled[0]!.weekMonday).toBe("2026-05-11");
    expect(unrolled[2]!.weekMonday).toBe("2026-05-18");

    const p1Week1 = unrolled.find((u) => u.projectId === "p1" && u.weekMonday === "2026-05-11");
    expect(p1Week1?.entryCount).toBe(2);
  });

  test("excludes tuples that already have a rollup", () => {
    db.exec(`
      INSERT INTO journal_entries (date, project_id, session_ids, headline, summary, generated_at, model_used)
      VALUES
        ('2026-05-11', 'p1', '[]', 'h1', 's1', datetime('now'), 't'),
        ('2026-05-12', 'p2', '[]', 'h2', 's2', datetime('now'), 't')
    `);
    db.exec(`
      INSERT INTO journal_rollups (period, period_start, project_id, summary, generated_at, model_used)
      VALUES ('week', '2026-05-11', 'p1', 'cached weekly', datetime('now'), 't')
    `);

    const unrolled = findUnrolledWeeks(db);
    expect(unrolled.length).toBe(1);
    expect(unrolled[0]!.projectId).toBe("p2");
  });
});
