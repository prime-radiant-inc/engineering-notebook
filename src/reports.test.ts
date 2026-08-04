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
