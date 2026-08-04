import { describe, test, expect, afterEach } from "bun:test";
import { startJob, jobStatus, renderReports } from "./reports";
import { storeReport } from "../../reports";
import { weekRangeForLabel } from "../../week";
import { initDb, closeDb } from "../../db";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

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

describe("renderReports", () => {
  let dir: string;
  let db: ReturnType<typeof initDb>;

  afterEach(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  test("renders the empty-state message when no report is stored", () => {
    dir = mkdtempSync(join(tmpdir(), "en-reports-view-"));
    db = initDb(join(dir, "t.db"));

    const html = renderReports(db, "2026-W31");

    expect(html).toContain("No report for 2026-W31 yet.");
  });

  test("renders the markdown, version, and template source for a stored report", () => {
    dir = mkdtempSync(join(tmpdir(), "en-reports-view-"));
    db = initDb(join(dir, "t.db"));
    const range = weekRangeForLabel("2026-W31");
    storeReport(db, {
      range,
      markdown: "## Summary\nA good week.",
      entryIds: [1],
      templateSource: "default",
      model: "test-model",
    });

    const html = renderReports(db, "2026-W31");

    expect(html).toContain("A good week.");
    expect(html).toContain("v1");
    expect(html).toContain("template: default");
    expect(html).not.toContain("No report for");
  });

  test("escapes HTML metacharacters in the markdown instead of emitting live markup", () => {
    dir = mkdtempSync(join(tmpdir(), "en-reports-view-"));
    db = initDb(join(dir, "t.db"));
    const range = weekRangeForLabel("2026-W31");
    storeReport(db, {
      range,
      markdown: "A & B <script>alert(1)</script>",
      entryIds: [1],
      templateSource: "default",
      model: "test-model",
    });

    const html = renderReports(db, "2026-W31");

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("A &amp; B &lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
