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
