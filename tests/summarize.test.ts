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
      topics: ["shipping", "deployment"],
      openQuestions: ["What about rollback?"],
    });

    const row = db
      .query(
        `SELECT headline, summary, topics, open_questions FROM journal_entries WHERE date = ? AND project_id = ?`
      )
      .get("2026-01-15", "my-project") as {
        headline: string;
        summary: string;
        topics: string;
        open_questions: string;
      } | null;

    expect(row).not.toBeNull();
    expect(row!.headline).toBe("Shipped the thing");
    expect(row!.summary).toBe("We shipped it.");
    expect(JSON.parse(row!.topics)).toEqual(["shipping", "deployment"]);
    expect(JSON.parse(row!.open_questions)).toEqual(["What about rollback?"]);
  });

  test("real entry upsert is idempotent", () => {
    upsertJournalEntry(db, group, {
      skipped: false,
      headline: "First headline",
      summary: "First summary.",
      topics: ["first"],
      openQuestions: [],
    });
    upsertJournalEntry(db, group, {
      skipped: false,
      headline: "Second headline",
      summary: "Second summary.",
      topics: ["second"],
      openQuestions: [],
    });

    const count = db
      .query(
        `SELECT COUNT(*) as n FROM journal_entries WHERE date = ? AND project_id = ?`
      )
      .get("2026-01-15", "my-project") as { n: number };
    expect(count.n).toBe(1);

    const row = db
      .query(`SELECT headline FROM journal_entries WHERE date = ? AND project_id = ?`)
      .get("2026-01-15", "my-project") as { headline: string } | null;
    expect(row).not.toBeNull();
    expect(row!.headline).toBe("Second headline");
  });
});
