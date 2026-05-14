import { describe, test, expect } from "bun:test";
import {
  mergeSpans,
  residualGaps,
  validateSpawnRange,
  scopedLength,
  type Scope,
  type Span,
} from "./recursive-summarize";

describe("mergeSpans", () => {
  test("returns empty for empty input", () => {
    const r = mergeSpans([]);
    expect(r.merged).toEqual([]);
    expect(r.covered).toBe(0);
  });

  test("returns single span unchanged", () => {
    const r = mergeSpans([[10, 20]]);
    expect(r.merged).toEqual([[10, 20]]);
    expect(r.covered).toBe(10);
  });

  test("merges overlapping spans", () => {
    const r = mergeSpans([
      [10, 20],
      [15, 30],
    ]);
    expect(r.merged).toEqual([[10, 30]]);
    expect(r.covered).toBe(20);
  });

  test("merges adjacent spans (touching at boundary)", () => {
    const r = mergeSpans([
      [10, 20],
      [20, 30],
    ]);
    expect(r.merged).toEqual([[10, 30]]);
    expect(r.covered).toBe(20);
  });

  test("keeps disjoint spans separate", () => {
    const r = mergeSpans([
      [10, 20],
      [30, 40],
    ]);
    expect(r.merged).toEqual([
      [10, 20],
      [30, 40],
    ]);
    expect(r.covered).toBe(20);
  });

  test("handles unsorted input", () => {
    const r = mergeSpans([
      [50, 60],
      [10, 20],
      [55, 70],
      [15, 25],
    ]);
    expect(r.merged).toEqual([
      [10, 25],
      [50, 70],
    ]);
    expect(r.covered).toBe(35);
  });
});

describe("residualGaps", () => {
  test("returns full scope when nothing covered", () => {
    expect(residualGaps(100, [])).toEqual([[0, 100]]);
  });

  test("returns nothing when fully covered", () => {
    expect(residualGaps(100, [[0, 100]])).toEqual([]);
  });

  test("identifies a single gap in the middle", () => {
    expect(residualGaps(100, [[0, 30], [50, 100]])).toEqual([[30, 50]]);
  });

  test("identifies leading and trailing gaps", () => {
    expect(residualGaps(100, [[20, 80]])).toEqual([
      [0, 20],
      [80, 100],
    ]);
  });

  test("handles overlapping covered spans", () => {
    expect(residualGaps(100, [
      [10, 30],
      [20, 50],
      [70, 90],
    ])).toEqual([
      [0, 10],
      [50, 70],
      [90, 100],
    ]);
  });
});

describe("validateSpawnRange", () => {
  // Parent scope of 100 chars
  test("accepts a half-sized child at the start", () => {
    expect(validateSpawnRange(100, 0, 50)).toBeNull();
  });

  test("accepts a half-sized child in the middle", () => {
    expect(validateSpawnRange(100, 25, 75)).toBeNull();
  });

  test("rejects a full-scope child", () => {
    expect(validateSpawnRange(100, 0, 100)).toMatch(/≤50%/);
  });

  test("rejects a 51%-of-parent child", () => {
    expect(validateSpawnRange(100, 0, 51)).toMatch(/≤50%/);
  });

  test("rejects out-of-bounds start", () => {
    expect(validateSpawnRange(100, -5, 30)).toMatch(/out of scope/);
  });

  test("rejects out-of-bounds end", () => {
    expect(validateSpawnRange(100, 50, 110)).toMatch(/out of scope/);
  });

  test("rejects empty range", () => {
    expect(validateSpawnRange(100, 50, 50)).toMatch(/empty range/);
    expect(validateSpawnRange(100, 50, 40)).toMatch(/empty range/);
  });

  test("accepts tiny child within budget", () => {
    expect(validateSpawnRange(1000, 100, 200)).toBeNull();
  });
});

describe("scopedLength", () => {
  test("returns end - start", () => {
    const scope: Scope = { globalStart: 100, globalEnd: 250, label: "x" };
    expect(scopedLength(scope)).toBe(150);
  });

  test("returns 0 for empty scope", () => {
    const scope: Scope = { globalStart: 50, globalEnd: 50, label: "empty" };
    expect(scopedLength(scope)).toBe(0);
  });
});
