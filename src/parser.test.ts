import { describe, test, expect } from "bun:test";
import { parseSession, type ParsedSession } from "./parser";
import { join } from "path";

const fixturePath = join(import.meta.dir, "../tests/fixtures/test-session-1.jsonl");
const codexFixturePath = join(import.meta.dir, "../tests/fixtures/test-codex-session-1.jsonl");
const subagentFixturePath = join(import.meta.dir, "../tests/fixtures/parent-session-id/subagents/agent-aba4e4e.jsonl");

describe("parseSession", () => {
  test("extracts session metadata", () => {
    const session = parseSession(fixturePath);
    expect(session.sessionId).toBe("test-session-1");
    expect(session.projectPath).toBe("/Users/jesse/projects/myapp");
    expect(session.gitBranch).toBe("main");
    expect(session.version).toBe("2.1.25");
    expect(session.startedAt).toBeTruthy();
    expect(session.endedAt).toBeTruthy();
  });

  test("extracts only user text and assistant text messages", () => {
    const session = parseSession(fixturePath);
    // Should have: "Fix the login bug", "I'll investigate...", "Found the bug...", "Great, fix it please", "Fixed the comparison..."
    // Should NOT have: thinking blocks, tool_use blocks, tool_result blocks, progress, system
    expect(session.messages.length).toBe(5);
  });

  test("skips tool_result user messages", () => {
    const session = parseSession(fixturePath);
    const userMessages = session.messages.filter((m) => m.role === "user");
    expect(userMessages.length).toBe(2);
    expect(userMessages[0].text).toBe("Fix the login bug");
    expect(userMessages[1].text).toBe("Great, fix it please");
  });

  test("skips thinking blocks from assistant", () => {
    const session = parseSession(fixturePath);
    const assistantMessages = session.messages.filter((m) => m.role === "assistant");
    for (const msg of assistantMessages) {
      expect(msg.text).not.toContain("Let me look at");
    }
  });

  test("skips assistant messages with only tool_use or thinking", () => {
    const session = parseSession(fixturePath);
    const assistantMessages = session.messages.filter((m) => m.role === "assistant");
    expect(assistantMessages.length).toBe(3);
  });

  test("generates conversation markdown", () => {
    const session = parseSession(fixturePath);
    const md = session.toMarkdown();
    expect(md).toContain("# Session: myapp");
    expect(md).toContain("**User (2026-02-02 17:37):** Fix the login bug");
    expect(md).toContain("**Claude (2026-02-02 17:37):** I'll investigate the login flow.");
    expect(md).toContain("**Claude (2026-02-02 17:38):** Found the bug.");
    expect(md).toContain("**User (2026-02-02 17:39):** Great, fix it please");
    expect(md).not.toContain("thinking");
    expect(md).not.toContain("tool_use");
    expect(md).not.toContain("tool_result");
  });

  test("counts messages correctly", () => {
    const session = parseSession(fixturePath);
    expect(session.messageCount).toBe(5);
  });

  test("parses Codex session metadata from session_meta", () => {
    const session = parseSession(codexFixturePath);
    expect(session.sessionId).toBe("019bf429-646d-70c2-a8b8-a0d69db3f01d");
    expect(session.projectPath).toBe("/Users/peteror/Code/engineering-notebook");
    expect(session.version).toBe("0.99.0-alpha.23");
    expect(session.gitBranch).toBe("main");
  });

  test("extracts only user/assistant text for Codex sessions", () => {
    const session = parseSession(codexFixturePath);
    expect(session.messages.length).toBe(2);
    expect(session.messages[0]?.role).toBe("user");
    expect(session.messages[0]?.text).toBe("Please add Codex support.");
    expect(session.messages[1]?.role).toBe("assistant");
    expect(session.messages[1]?.text).toContain("I'll add Codex support.");
  });

  test("skips Codex bootstrap user messages", () => {
    const session = parseSession(codexFixturePath);
    const joined = session.messages.map((m) => m.text).join("\n");
    expect(joined).not.toContain("# AGENTS.md instructions");
    expect(joined).not.toContain("<environment_context>");
  });

  test("parses subagent files without skipping records", () => {
    // Subagent files have the parent sessionId in every record,
    // but this should NOT trigger continuation detection.
    const session = parseSession(subagentFixturePath);
    // Should have 3 messages: 1 user + 2 assistant text messages
    expect(session.messages.length).toBe(3);
    expect(session.messages[0].role).toBe("user");
    expect(session.messages[0].text).toBe("Refactor the auth module");
    expect(session.messages[1].role).toBe("assistant");
    expect(session.messages[1].text).toBe("I'll refactor the auth module now.");
    expect(session.messages[2].role).toBe("assistant");
    expect(session.messages[2].text).toBe("Done refactoring the auth module.");
  });

  test("subagent file preserves timestamps", () => {
    const session = parseSession(subagentFixturePath);
    expect(session.startedAt).toBeTruthy();
    expect(session.endedAt).toBeTruthy();
  });
});
