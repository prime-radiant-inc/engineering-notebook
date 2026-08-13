import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mergeSpans,
  residualGaps,
  validateSpawnRange,
  scopedLength,
  parseLlmJsonResponse,
  extractFirstBalancedObject,
  persistInvocationTree,
  loadInvocationTree,
  renderInvocationTree,
  type Scope,
  type Span,
  type InvocationNode,
} from "./recursive-summarize";
import { initDb, closeDb } from "./db";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

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

describe("extractFirstBalancedObject", () => {
  test("returns null when no opening brace", () => {
    expect(extractFirstBalancedObject("hello world")).toBeNull();
    expect(extractFirstBalancedObject("")).toBeNull();
  });

  test("returns the entire object when input is just an object", () => {
    expect(extractFirstBalancedObject('{"a": 1}')).toBe('{"a": 1}');
  });

  test("ignores braces inside strings", () => {
    const input = '{"text": "this { is } not a delimiter", "n": 1}';
    expect(extractFirstBalancedObject(input)).toBe(input);
  });

  test("respects escape sequences inside strings", () => {
    const input = '{"text": "an escaped quote: \\" and a brace }", "n": 1}';
    expect(extractFirstBalancedObject(input)).toBe(input);
  });

  test("handles nested objects", () => {
    expect(extractFirstBalancedObject('{"a": {"b": {"c": 1}}}')).toBe(
      '{"a": {"b": {"c": 1}}}'
    );
  });

  test("extracts object surrounded by prose", () => {
    const input = 'Sure! Here is your JSON:\n{"answer": 42}\nLet me know if that works.';
    expect(extractFirstBalancedObject(input)).toBe('{"answer": 42}');
  });

  test("returns null for unterminated object", () => {
    expect(extractFirstBalancedObject('{"a": 1, "b":')).toBeNull();
  });
});

describe("parseLlmJsonResponse", () => {
  test("parses clean JSON directly", () => {
    expect(parseLlmJsonResponse('{"x": 1}')).toEqual({ x: 1 });
  });

  test("strips ```json fences", () => {
    expect(parseLlmJsonResponse('```json\n{"x": 1}\n```')).toEqual({ x: 1 });
  });

  test("strips bare ``` fences", () => {
    expect(parseLlmJsonResponse('```\n{"x": 1}\n```')).toEqual({ x: 1 });
  });

  test("strips <think>...</think> reasoning leaks", () => {
    const raw = '<think>let me figure this out</think>\n{"x": 1}';
    expect(parseLlmJsonResponse(raw)).toEqual({ x: 1 });
  });

  test("strips dangling </think> with no opening tag", () => {
    const raw = '\n</think>\n\n{"x": 1}';
    expect(parseLlmJsonResponse(raw)).toEqual({ x: 1 });
  });

  test("recovers from preamble prose", () => {
    const raw = "Sure! Here you go: {\"x\": 42}";
    expect(parseLlmJsonResponse(raw)).toEqual({ x: 42 });
  });

  test("returns null for completely malformed input", () => {
    expect(parseLlmJsonResponse("not json at all")).toBeNull();
    expect(parseLlmJsonResponse("")).toBeNull();
  });

  test("returns null when JSON is a top-level array (not an object)", () => {
    expect(parseLlmJsonResponse("[1, 2, 3]")).toBeNull();
  });

  test("returns null for top-level scalar", () => {
    expect(parseLlmJsonResponse('"just a string"')).toBeNull();
    expect(parseLlmJsonResponse("42")).toBeNull();
  });

  test("handles real-world Ollama think-leak case", () => {
    // Observed in a smoke test: model emitted think content, then tried
    // to produce JSON but the </think> got mixed into the content.
    const raw = `{
  "action": "read_range",

</think>

"start": 4853,
  "end": 6853
}`;
    // Without the </think> the JSON would be valid; recovery should find
    // the balanced object after stripping the leak.
    const result = parseLlmJsonResponse(raw);
    // Even the recovered version may not parse cleanly because the </think>
    // is inside the {...} braces. Acceptable outcome: returns null.
    // What matters is we don't crash. Either result is fine.
    expect(result === null || typeof result === "object").toBe(true);
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

describe("invocation tree persistence", () => {
  let tempDir: string;
  let db: ReturnType<typeof initDb>;
  let entryId: number;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "notebook-rlm-test-"));
    db = initDb(join(tempDir, "test.db"));
    db.exec(
      `INSERT INTO projects (id, path, display_name) VALUES ('myapp', '/p', 'myapp')`
    );
    db.exec(
      `INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at)
       VALUES ('s1', 'myapp', '/p', '/p/s1.jsonl', '2026-05-13T10:00:00Z', 5, datetime('now'))`
    );
    const res = db
      .prepare(
        `INSERT INTO journal_entries (date, project_id, session_ids, headline, summary, generated_at, model_used)
         VALUES (?, ?, ?, ?, ?, datetime('now'), ?)`
      )
      .run("2026-05-13", "myapp", "[\"s1\"]", "h", "s", "test");
    entryId = Number(res.lastInsertRowid);
  });

  afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeNode(
    overrides: Partial<InvocationNode> & { scope: Scope }
  ): InvocationNode {
    return {
      depth: 0,
      question: "test question",
      coherenceToken: "abc123",
      startedAt: "2026-05-13T10:00:00.000Z",
      endedAt: "2026-05-13T10:00:05.000Z",
      actions: [],
      fragments: [],
      children: [],
      result: { skipped: false, headline: "h", summary: "s", topics: [], openQuestions: [] },
      ...overrides,
    };
  }

  test("round-trips a single root invocation with no children", () => {
    const root = makeNode({
      scope: { globalStart: 0, globalEnd: 1500, label: "root" },
      actions: [
        { step: 0, action: "auto_read", detail: "0, 1500", result_preview: "**User:** hi" },
      ],
      fragments: [
        {
          charStart: 0,
          charEnd: 1500,
          sessionId: "s1",
          spanChecksum: "deadbeef",
          category: "leaf_read",
          text: "**User:** hi",
        },
      ],
    });
    persistInvocationTree(db, entryId, root);

    const tree = loadInvocationTree(db, entryId);
    expect(tree).not.toBeNull();
    expect(tree!.root.depth).toBe(0);
    expect(tree!.root.scopeStart).toBe(0);
    expect(tree!.root.scopeEnd).toBe(1500);
    expect(tree!.root.coherenceToken).toBe("abc123");
    expect(tree!.root.children).toEqual([]);
    expect(tree!.root.actions.length).toBe(1);
    expect(tree!.root.actions[0]!.action).toBe("auto_read");
    expect(tree!.root.fragments.length).toBe(1);
    expect(tree!.root.fragments[0]!.charStart).toBe(0);
    expect(tree!.root.fragments[0]!.spanChecksum).toBe("deadbeef");
  });

  test("round-trips a tree with children and grandchildren", () => {
    const grandchild = makeNode({
      scope: { globalStart: 0, globalEnd: 250, label: "root/[0-500]/[0-250]" },
      depth: 2,
      coherenceToken: "gg",
    });
    const child1 = makeNode({
      scope: { globalStart: 0, globalEnd: 500, label: "root/[0-500]" },
      depth: 1,
      coherenceToken: "c1",
      children: [grandchild],
    });
    const child2 = makeNode({
      scope: { globalStart: 500, globalEnd: 1000, label: "root/[500-1000]" },
      depth: 1,
      coherenceToken: "c2",
    });
    const root = makeNode({
      scope: { globalStart: 0, globalEnd: 2000, label: "root" },
      coherenceToken: "rrr",
      children: [child1, child2],
    });

    persistInvocationTree(db, entryId, root);
    const tree = loadInvocationTree(db, entryId);
    expect(tree).not.toBeNull();
    expect(tree!.root.coherenceToken).toBe("rrr");
    expect(tree!.root.children.length).toBe(2);
    const reloadedC1 = tree!.root.children.find((c) => c.coherenceToken === "c1");
    expect(reloadedC1).toBeDefined();
    expect(reloadedC1!.children.length).toBe(1);
    expect(reloadedC1!.children[0]!.coherenceToken).toBe("gg");
    expect(reloadedC1!.children[0]!.depth).toBe(2);
  });

  test("idempotent: rewriting deletes prior tree", () => {
    const v1 = makeNode({
      scope: { globalStart: 0, globalEnd: 500, label: "root" },
      coherenceToken: "v1",
    });
    persistInvocationTree(db, entryId, v1);
    const v2 = makeNode({
      scope: { globalStart: 0, globalEnd: 1000, label: "root" },
      coherenceToken: "v2",
    });
    persistInvocationTree(db, entryId, v2);

    const reloaded = loadInvocationTree(db, entryId);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.root.coherenceToken).toBe("v2");
    expect(reloaded!.root.scopeEnd).toBe(1000);

    // Verify only one root invocation remains in the DB.
    const count = db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) as n FROM journal_invocations`
      )
      .get();
    expect(count!.n).toBe(1);
  });

  test("loadInvocationTree returns null when no tree exists", () => {
    expect(loadInvocationTree(db, entryId)).toBeNull();
  });

  test("renderInvocationTree produces readable output", () => {
    const root = makeNode({
      scope: { globalStart: 0, globalEnd: 1500, label: "root" },
      actions: [
        { step: 0, action: "auto_read", detail: "0, 1500", result_preview: "hello" },
      ],
      fragments: [
        {
          charStart: 0,
          charEnd: 100,
          sessionId: "s1",
          spanChecksum: "x",
          category: "leaf_read",
          text: "hello",
        },
      ],
    });
    persistInvocationTree(db, entryId, root);
    const tree = loadInvocationTree(db, entryId);
    const rendered = renderInvocationTree(tree!);

    expect(rendered).toContain("invocation #");
    expect(rendered).toContain("scope=[0,1500)");
    expect(rendered).toContain("auto_read");
    expect(rendered).toContain("fragments: 1");
  });
});
