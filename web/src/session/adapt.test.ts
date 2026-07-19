import { describe, test, expect } from "vitest";
import { extractTitle } from "./adapt";
import type { ParsedMessage } from "./types";

// Matches claude-session-viewer's extractFirstPrompt: skip isMeta, first user
// text block, sliced to 200 — no command cleaning (identical output to the viewer).
describe("extractTitle (viewer-identical)", () => {
  test("skips the isMeta caveat and returns the next user text verbatim", () => {
    const msgs: ParsedMessage[] = [
      { type: "user", uuid: "0", isMeta: true, isToolResult: false, content: [{ type: "text", text: "<local-command-caveat>Caveat…</local-command-caveat>" }] },
      { type: "user", uuid: "1", isToolResult: false, content: [{ type: "text", text: "<command-name>/plugin</command-name>" }] },
    ];
    expect(extractTitle(msgs)).toBe("<command-name>/plugin</command-name>");
  });

  test("returns a plain first prompt unchanged, truncated to 200 chars", () => {
    const long = "a".repeat(250);
    expect(extractTitle([{ type: "user", uuid: "0", isToolResult: false, content: [{ type: "text", text: long }] }])).toBe("a".repeat(200));
  });
});
