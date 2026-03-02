import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { groupSessionsByDateAndProject, buildSummaryPrompt, parseSummaryResponse, logicalDate, splitConversationByDay } from "./summarize";
import { initDb, closeDb } from "./db";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("summarize", () => {
  let tempDir: string;
  let db: ReturnType<typeof initDb>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "notebook-sum-test-"));
    db = initDb(join(tempDir, "test.db"));

    // Insert test data
    db.exec(`
      INSERT INTO projects (id, path, display_name, session_count)
      VALUES ('myapp', '/test/myapp', 'My App', 2);

      INSERT INTO sessions (id, project_id, project_path, source_path, started_at, ended_at, message_count, ingested_at)
      VALUES
        ('s1', 'myapp', '/test/myapp', '/tmp/s1.jsonl', '2026-02-02T10:00:00Z', '2026-02-02T11:00:00Z', 5, datetime('now')),
        ('s2', 'myapp', '/test/myapp', '/tmp/s2.jsonl', '2026-02-02T14:00:00Z', '2026-02-02T15:00:00Z', 3, datetime('now'));

      INSERT INTO conversations (session_id, conversation_markdown, extracted_at)
      VALUES
        ('s1', '**User (2026-02-02 10:00):** Fix the bug\n**Claude (2026-02-02 10:01):** Fixed it.', datetime('now')),
        ('s2', '**User (2026-02-02 14:00):** Add tests\n**Claude (2026-02-02 14:01):** Added tests.', datetime('now'));
    `);
  });

  afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("groupSessionsByDateAndProject groups correctly", () => {
    const groups = groupSessionsByDateAndProject(db);
    expect(groups.length).toBe(1);
    expect(groups[0]!.date).toBe("2026-02-02");
    expect(groups[0]!.projectId).toBe("myapp");
    expect(groups[0]!.sessionIds).toEqual(["s1", "s2"]);
    expect(groups[0]!.conversations.length).toBe(2);
  });

  test("buildSummaryPrompt produces valid prompt", () => {
    const groups = groupSessionsByDateAndProject(db);
    const prompt = buildSummaryPrompt(groups[0]!);
    expect(prompt).toContain("Fix the bug");
    expect(prompt).toContain("Add tests");
    expect(prompt).toContain("engineering journal entry");
  });

  test("parseSummaryResponse extracts headline, summary, topics, and open questions", () => {
    const response = `HEADLINE: Shipped onboarding flow and fixed auth bug
SUMMARY: Spent the morning building the onboarding wizard. After lunch, fixed a production OAuth token expiry issue caused by clock skew.
TOPICS: ["onboarding flow", "OAuth token bug", "production hotfix"]
OPEN_QUESTIONS: ["Need to add email verification step to onboarding", "Should we add rate limiting to the OAuth refresh endpoint?"]`;
    const result = parseSummaryResponse(response);
    expect(result.skipped).toBe(false);
    if (!result.skipped) {
      expect(result.headline).toBe("Shipped onboarding flow and fixed auth bug");
      expect(result.summary).toContain("onboarding wizard");
      expect(result.topics).toEqual(["onboarding flow", "OAuth token bug", "production hotfix"]);
      expect(result.openQuestions).toEqual([
        "Need to add email verification step to onboarding",
        "Should we add rate limiting to the OAuth refresh endpoint?",
      ]);
    }
  });

  test("parseSummaryResponse handles missing open questions", () => {
    const response = `HEADLINE: Quick fix
SUMMARY: Fixed a typo.
TOPICS: ["bugfix"]`;
    const result = parseSummaryResponse(response);
    expect(result.skipped).toBe(false);
    if (!result.skipped) {
      expect(result.topics).toEqual(["bugfix"]);
      expect(result.openQuestions).toEqual([]);
    }
  });

  test("parseSummaryResponse detects SKIP response", () => {
    const response = `SKIP: Automated test run with no substantive engineering discussion`;
    const result = parseSummaryResponse(response);
    expect(result.skipped).toBe(true);
    if (result.skipped) {
      expect(result.skipReason).toBe("Automated test run with no substantive engineering discussion");
    }
  });

  test("parseSummaryResponse handles SKIP with extra whitespace", () => {
    const response = `SKIP:   Single-shot bot query   `;
    const result = parseSummaryResponse(response);
    expect(result.skipped).toBe(true);
    if (result.skipped) {
      expect(result.skipReason).toBe("Single-shot bot query");
    }
  });

  test("parseSummaryResponse does not treat SKIP in body as skip", () => {
    const response = `HEADLINE: Discussed whether to skip the cache layer
SUMMARY: Talked about skipping the cache.
TOPICS: ["caching"]
OPEN_QUESTIONS: []`;
    const result = parseSummaryResponse(response);
    expect(result.skipped).toBe(false);
  });

  test("parseSummaryResponse returns skipped:false for normal response", () => {
    const response = `HEADLINE: Shipped feature
SUMMARY: Built and shipped the feature.
TOPICS: ["feature"]
OPEN_QUESTIONS: []`;
    const result = parseSummaryResponse(response);
    expect(result.skipped).toBe(false);
    if (!result.skipped) {
      expect(result.headline).toBe("Shipped feature");
    }
  });
});

describe("logicalDate", () => {
  test("logicalDate returns same day for afternoon timestamps", () => {
    expect(logicalDate("2026-02-21 17:37", 5)).toBe("2026-02-21");
  });

  test("logicalDate returns previous day for early morning timestamps", () => {
    expect(logicalDate("2026-02-21 03:30", 5)).toBe("2026-02-20");
  });

  test("logicalDate returns same day at exactly day_start_hour", () => {
    expect(logicalDate("2026-02-21 05:00", 5)).toBe("2026-02-21");
  });

  test("logicalDate handles midnight boundary", () => {
    expect(logicalDate("2026-02-21 00:00", 5)).toBe("2026-02-20");
  });
});

describe("splitConversationByDay", () => {
  test("returns null for old-format timestamps", () => {
    const md = "**User (10:00):** Hello\n**Claude (10:01):** Hi there.";
    expect(splitConversationByDay(md, 5)).toBeNull();
  });

  test("groups all messages to one day when no boundary crossed", () => {
    const md = [
      "**User (2026-02-20 10:00):** First message",
      "**Claude (2026-02-20 10:05):** Response",
      "**User (2026-02-20 11:00):** Second message",
    ].join("\n");
    const result = splitConversationByDay(md, 5)!;
    expect(result.size).toBe(1);
    expect(result.has("2026-02-20")).toBe(true);
    expect(result.get("2026-02-20")).toContain("First message");
    expect(result.get("2026-02-20")).toContain("Second message");
  });

  test("splits messages across midnight boundary using logical date", () => {
    const md = [
      "**User (2026-02-20 22:00):** Late night work",
      "**Claude (2026-02-20 22:05):** Working on it.",
      "**User (2026-02-21 01:30):** Still going",
      "**Claude (2026-02-21 01:35):** Almost done.",
      "**User (2026-02-21 06:00):** Morning follow-up",
    ].join("\n");
    const result = splitConversationByDay(md, 5)!;
    expect(result.size).toBe(2);
    // 22:00 and 01:30 both belong to Feb 20 (01:30 < 5 AM => previous day)
    expect(result.get("2026-02-20")).toContain("Late night work");
    expect(result.get("2026-02-20")).toContain("Still going");
    expect(result.get("2026-02-20")).toContain("Almost done.");
    // 06:00 belongs to Feb 21
    expect(result.get("2026-02-21")).toContain("Morning follow-up");
  });

  test("attaches continuation lines to current day", () => {
    const md = [
      "**User (2026-02-20 10:00):** Start",
      "Some continuation text",
      "**Claude (2026-02-20 10:05):** Reply",
    ].join("\n");
    const result = splitConversationByDay(md, 5)!;
    expect(result.size).toBe(1);
    expect(result.get("2026-02-20")).toContain("Some continuation text");
  });
});

describe("groupSessionsByDateAndProject - midnight spanning", () => {
  let tempDir: string;
  let db: ReturnType<typeof initDb>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "notebook-midnight-test-"));
    db = initDb(join(tempDir, "test.db"));

    db.exec(`
      INSERT INTO projects (id, path, display_name, session_count)
      VALUES ('myapp', '/test/myapp', 'My App', 1);

      INSERT INTO sessions (id, project_id, project_path, source_path, started_at, ended_at, message_count, ingested_at)
      VALUES
        ('s-midnight', 'myapp', '/test/myapp', '/tmp/sm.jsonl', '2026-02-20T22:00:00Z', '2026-02-21T06:30:00Z', 5, datetime('now'));

      INSERT INTO conversations (session_id, conversation_markdown, extracted_at)
      VALUES
        ('s-midnight', '**User (2026-02-20 22:00):** Late night refactor\n**Claude (2026-02-20 22:10):** Starting the refactor.\n**User (2026-02-21 01:30):** Still at it\n**Claude (2026-02-21 01:35):** Almost done.\n**User (2026-02-21 06:00):** Morning review\n**Claude (2026-02-21 06:05):** Looks good.', datetime('now'));
    `);
  });

  afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("splits a midnight-spanning session into two date groups", () => {
    const groups = groupSessionsByDateAndProject(db);
    expect(groups.length).toBe(2);

    const sorted = groups.sort((a, b) => a.date.localeCompare(b.date));

    // Feb 20: messages at 22:00, 22:10, 01:30, 01:35 (all logical date Feb 20)
    expect(sorted[0]!.date).toBe("2026-02-20");
    expect(sorted[0]!.projectId).toBe("myapp");
    expect(sorted[0]!.sessionIds).toEqual(["s-midnight"]);
    expect(sorted[0]!.conversations[0]).toContain("Late night refactor");
    expect(sorted[0]!.conversations[0]).toContain("Still at it");

    // Feb 21: messages at 06:00, 06:05 (logical date Feb 21)
    expect(sorted[1]!.date).toBe("2026-02-21");
    expect(sorted[1]!.projectId).toBe("myapp");
    expect(sorted[1]!.sessionIds).toEqual(["s-midnight"]);
    expect(sorted[1]!.conversations[0]).toContain("Morning review");
  });

  test("filters out already-summarized date+project combos", () => {
    // Insert a journal entry for Feb 20
    db.exec(`
      INSERT INTO journal_entries (date, project_id, session_ids, headline, summary, topics, generated_at, model_used)
      VALUES ('2026-02-20', 'myapp', '["s-midnight"]', 'Test', 'Test summary', '[]', datetime('now'), 'test-model');
    `);

    const groups = groupSessionsByDateAndProject(db);
    // Only Feb 21 should remain
    expect(groups.length).toBe(1);
    expect(groups[0]!.date).toBe("2026-02-21");
  });

  test("filterDate works with logical dates", () => {
    const groups = groupSessionsByDateAndProject(db, "2026-02-21");
    expect(groups.length).toBe(1);
    expect(groups[0]!.date).toBe("2026-02-21");
    expect(groups[0]!.conversations[0]).toContain("Morning review");
  });
});
