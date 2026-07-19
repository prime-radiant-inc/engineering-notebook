import { describe, test, expect } from "vitest";
import { cleanCommandText, extractTitle, isDisplayableMessage } from "./adapt";
import type { ParsedMessage } from "./types";

describe("isDisplayableMessage", () => {
  const u = (text: string, extra: Partial<ParsedMessage> = {}): ParsedMessage =>
    ({ type: "user", uuid: "x", isToolResult: false, content: [{ type: "text", text }], ...extra });

  test("hides isMeta (caveat) and pure command output", () => {
    expect(isDisplayableMessage(u("<local-command-caveat>c</local-command-caveat>", { isMeta: true }))).toBe(false);
    expect(isDisplayableMessage(u("<local-command-stdout>Successfully added</local-command-stdout>"))).toBe(false);
  });

  test("keeps a real prompt, a slash-command invocation, and tool results", () => {
    expect(isDisplayableMessage(u("please build it"))).toBe(true);
    expect(isDisplayableMessage(u("<command-name>/plugin</command-name><command-args>install</command-args>"))).toBe(true);
    expect(isDisplayableMessage({ type: "user", uuid: "r", isToolResult: true, content: [{ type: "tool_result", tool_use_id: "t", content: "out" }] })).toBe(true);
  });
});

describe("title extraction", () => {
  test("cleanCommandText turns a slash command into a readable title", () => {
    const raw = "<command-name>/plugin</command-name>\n<command-message>plugin</command-message>\n<command-args>marketplace add obra/superpowers-marketplace</command-args>";
    expect(cleanCommandText(raw)).toBe("/plugin marketplace add obra/superpowers-marketplace");
  });

  test("cleanCommandText strips local-command caveat/stdout wrappers", () => {
    expect(cleanCommandText("<local-command-caveat>Caveat: do not respond</local-command-caveat>")).toBe("");
    expect(cleanCommandText("<local-command-stdout>ok</local-command-stdout>")).toBe("");
  });

  test("extractTitle skips isMeta and command-output, returns the cleaned command", () => {
    const msgs: ParsedMessage[] = [
      { type: "user", uuid: "0", isMeta: true, isToolResult: false, content: [{ type: "text", text: "<local-command-caveat>Caveat…</local-command-caveat>" }] },
      { type: "user", uuid: "1", isToolResult: false, content: [{ type: "text", text: "<command-name>/plugin</command-name>\n<command-args>install superpowers</command-args>" }] },
    ];
    expect(extractTitle(msgs)).toBe("/plugin install superpowers");
  });

  test("extractTitle returns a plain first prompt unchanged", () => {
    const msgs: ParsedMessage[] = [
      { type: "user", uuid: "0", isToolResult: false, content: [{ type: "text", text: "get the repo and build it" }] },
    ];
    expect(extractTitle(msgs)).toBe("get the repo and build it");
  });
});
