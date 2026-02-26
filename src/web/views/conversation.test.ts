import { describe, test, expect } from "bun:test";
import { renderConversation } from "./conversation";

describe("renderConversation", () => {
  test("renders empty state for missing markdown", () => {
    const html = renderConversation("");
    expect(html).toContain("No conversation data");
  });

  test("renders user message with outset label and inline timestamp", () => {
    const md = "**User (2026-02-21 17:37):** Fix the login bug";
    const html = renderConversation(md, "peteror");
    expect(html).toContain("msg-label");
    expect(html).toContain("peteror");
    expect(html).toContain("msg-body-user");
    expect(html).toContain("Fix the login bug");
    expect(html).toContain("5:37 PM");
  });

  test("renders Claude message with light weight class", () => {
    const md = "**Claude (2026-02-21 17:37):** I'll investigate";
    const html = renderConversation(md);
    expect(html).toContain("msg-body-claude");
    expect(html).toContain("Claude");
  });

  test("merges consecutive messages from same speaker", () => {
    const md = [
      "**Claude (2026-02-21 17:37):** First message",
      "**Claude (2026-02-21 17:38):** Second message",
    ].join("\n");
    const html = renderConversation(md);
    // Should only have one "Claude" label, not two
    const labelMatches = html.match(/msg-label/g);
    expect(labelMatches?.length).toBe(1);
    // Both messages should be in the body
    expect(html).toContain("First message");
    expect(html).toContain("Second message");
  });

  test("adds separator on speaker change", () => {
    const md = [
      "**User (2026-02-21 17:37):** Fix the bug",
      "**Claude (2026-02-21 17:37):** On it",
      "**User (2026-02-21 17:39):** Thanks",
    ].join("\n");
    const html = renderConversation(md);
    // The second user message should have speaker-change separator
    expect(html).toContain("msg-speaker-change");
  });

  test("does not add separator between consecutive same-speaker messages", () => {
    const md = [
      "**Claude (2026-02-21 17:37):** First part",
      "**Claude (2026-02-21 17:38):** Second part",
    ].join("\n");
    const html = renderConversation(md);
    expect(html).not.toContain("msg-speaker-change");
  });

  test("handles old-format timestamps (HH:MM only)", () => {
    const md = "**User (17:37):** Old format message";
    const html = renderConversation(md);
    expect(html).toContain("Old format message");
    expect(html).toContain("5:37 PM");
  });

  test("normalizes speaker names", () => {
    const md = [
      "**Human (2026-02-21 17:37):** First",
      "**Assistant (2026-02-21 17:37):** Second",
    ].join("\n");
    const html = renderConversation(md, "peteror");
    expect(html).toContain("peteror");
    expect(html).toContain("Claude");
  });

  test("renders explicit user labels from markdown", () => {
    const md = "**peteror (2026-02-21 17:37):** Hello";
    const html = renderConversation(md);
    expect(html).toContain("peteror");
  });

  test("can remap Claude/Assistant labels to Codex for legacy codex transcripts", () => {
    const md = [
      "**Claude (2026-02-21 17:37):** First",
      "**Assistant (2026-02-21 17:38):** Second",
    ].join("\n");
    const html = renderConversation(md, "peteror", "Codex");
    expect(html).toContain("Codex");
    expect(html).not.toContain("msg-label\">Claude");
  });
});
