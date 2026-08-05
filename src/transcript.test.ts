import { describe, test, expect } from "bun:test";
import { parseTranscript } from "./transcript";

const claudeLines = [
  JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "hi" }] } }),
  JSON.stringify({ type: "assistant", message: { content: [
    { type: "thinking", thinking: "let me think" },
    { type: "text", text: "answer" },
    { type: "tool_use", name: "Bash", input: { command: "ls" } },
  ] } }),
  JSON.stringify({ type: "user", message: { content: [
    { type: "tool_result", tool_use_id: "t1", content: "file-a\nfile-b" },
  ] } }),
  "",
  "{ not json",
].join("\n");

describe("parseTranscript", () => {
  test("parses claude blocks in order with kinds/roles/names", () => {
    const { items, format } = parseTranscript(claudeLines);
    expect(format).toBe("claude");
    expect(items).toEqual([
      { role: "user", kind: "text", content: "hi" },
      { role: "assistant", kind: "thinking", content: "let me think" },
      { role: "assistant", kind: "text", content: "answer" },
      { role: "assistant", kind: "tool_use", name: "Bash", input: { command: "ls" }, content: JSON.stringify({ command: "ls" }, null, 2) },
      { role: "user", kind: "tool_result", toolUseId: "t1", content: "file-a\nfile-b" },
    ]);
  });

  test("captures tool_use id, structured input, and tool_result toolUseId", () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: { content: [
        { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/x.ts" } },
      ] } }),
      JSON.stringify({ type: "user", message: { content: [
        { type: "tool_result", tool_use_id: "tu_1", content: "ok" },
      ] } }),
    ].join("\n");
    const { items } = parseTranscript(lines);
    expect(items[0]).toEqual({ role: "assistant", kind: "tool_use", name: "Read", id: "tu_1", input: { file_path: "/x.ts" }, content: JSON.stringify({ file_path: "/x.ts" }, null, 2) });
    expect(items[1]).toEqual({ role: "user", kind: "tool_result", toolUseId: "tu_1", content: "ok" });
  });

  test("tool_result with array content joins text blocks", () => {
    const line = JSON.stringify({ type: "user", message: { content: [
      { type: "tool_result", content: [{ type: "text", text: "line1" }, { type: "text", text: "line2" }] },
    ] } });
    const { items } = parseTranscript(line);
    expect(items[0]).toEqual({ role: "user", kind: "tool_result", content: "line1\nline2" });
  });

  test("string message content becomes a single text item", () => {
    const line = JSON.stringify({ type: "assistant", message: { content: "plain" } });
    expect(parseTranscript(line).items).toEqual([{ role: "assistant", kind: "text", content: "plain" }]);
  });

  test("codex records parse to text-only items", () => {
    const lines = [
      JSON.stringify({ type: "session_meta", payload: { id: "x" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "u" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "a" }] } }),
    ].join("\n");
    const { items, format } = parseTranscript(lines);
    expect(format).toBe("codex");
    expect(items).toEqual([
      { role: "user", kind: "text", content: "u" },
      { role: "assistant", kind: "text", content: "a" },
    ]);
  });

  test("empty input → no items, unknown format", () => {
    expect(parseTranscript("")).toEqual({ items: [], format: "unknown" });
  });
});
