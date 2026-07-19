import { describe, test, expect } from "bun:test";
import { renderSessionFooter } from "./session";
import { beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../../db";
import { createGroup, assignSession } from "../../groups";
import { renderSessionDetail, toolPreview } from "./session";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("renderSessionFooter", () => {
  test("renders Claude resume command for Claude session source paths", () => {
    const html = renderSessionFooter(
      "abc-session-id",
      "/Users/peteror/Code/engineering-notebook",
      "/Users/peteror/.claude/projects/myproj/abc-session-id.jsonl"
    );

    expect(html).toContain("claude --resume abc-session-id");
    expect(html).not.toContain("codex resume");
  });

  test("renders Codex resume command for Codex session source paths", () => {
    const html = renderSessionFooter(
      "019bf429-646d-70c2-a8b8-a0d69db3f01d",
      "/Users/peteror/Code/engineering-notebook",
      "/Users/peteror/.codex/sessions/2026/02/24/rollout-2026-02-24T09-00-00-019bf429-646d-70c2-a8b8-a0d69db3f01d.jsonl"
    );

    expect(html).toContain("codex resume 019bf429-646d-70c2-a8b8-a0d69db3f01d");
    expect(html).not.toContain("claude --resume");
  });
});

describe("session detail group control", () => {
  let tempDir: string;
  let db: ReturnType<typeof initDb>;

  function seed(id: string) {
    db.query("INSERT OR IGNORE INTO projects (id, path, display_name) VALUES ('p','/tmp/p','Proj')").run();
    db.query(
      `INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at)
       VALUES (?, 'p', '/tmp/p', '/tmp/s.jsonl', '2026-07-10T00:00:00Z', 3, datetime('now'))`
    ).run(id);
    db.query("INSERT INTO conversations (session_id, conversation_markdown, extracted_at) VALUES (?, '# hi', datetime('now'))").run(id);
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "notebook-sessionctl-test-"));
    db = initDb(join(tempDir, "test.db"));
  });
  afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("renders an assign form with a None option and each group", () => {
    seed("s1");
    createGroup(db, "Trading");
    createGroup(db, "Infra");
    const html = renderSessionDetail(db, "s1");
    expect(html).toContain('action="/sessions/s1/group"');
    expect(html).toContain("None");
    expect(html).toContain("Trading");
    expect(html).toContain("Infra");
  });

  test("preselects the session's current group", () => {
    seed("s1");
    const gid = createGroup(db, "Trading");
    assignSession(db, "s1", gid);
    const html = renderSessionDetail(db, "s1");
    expect(html).toMatch(new RegExp(`<option value="${gid}" selected`));
  });
});

describe("session detail thinking/tools toggle", () => {
  let tempDir: string;
  let db: ReturnType<typeof initDb>;

  const jsonl = [
    JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "the question" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [
      { type: "thinking", thinking: "SECRET_REASONING" },
      { type: "text", text: "the answer" },
      { type: "tool_use", name: "Bash", input: { command: "ls" } },
    ] } }),
  ].join("\n");

  function seedWithFile(id: string, sourcePath: string) {
    db.query("INSERT OR IGNORE INTO projects (id, path, display_name) VALUES ('p','/tmp/p','P')").run();
    db.query(
      `INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at)
       VALUES (?, 'p', '/tmp/p', ?, '2026-07-10T00:00:00Z', 2, datetime('now'))`
    ).run(id, sourcePath);
    db.query("INSERT INTO conversations (session_id, conversation_markdown, extracted_at) VALUES (?, '# md the answer', datetime('now'))").run(id);
  }

  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), "tt-test-")); db = initDb(join(tempDir, "t.db")); });
  afterEach(() => { closeDb(); rmSync(tempDir, { recursive: true, force: true }); });

  test("default render shows toggle controls and no thinking/tool content", () => {
    const src = join(tempDir, "s.jsonl"); writeFileSync(src, jsonl);
    seedWithFile("s1", src);
    const html = renderSessionDetail(db, "s1");
    expect(html).toContain("Show thinking");
    expect(html).toContain("Show tools");
    expect(html).not.toContain("SECRET_REASONING");
  });

  test("showThinking re-parses the file and renders thinking; control flips to Hide", () => {
    const src = join(tempDir, "s.jsonl"); writeFileSync(src, jsonl);
    seedWithFile("s1", src);
    const html = renderSessionDetail(db, "s1", { showThinking: true });
    expect(html).toContain("SECRET_REASONING");
    expect(html).toContain("Hide thinking");
    expect(html).not.toContain('"input"'); // tools not shown
    expect(html).not.toContain("Bash"); // tool name not shown
  });

  test("showTools renders tool call, not thinking", () => {
    const src = join(tempDir, "s.jsonl"); writeFileSync(src, jsonl);
    seedWithFile("s1", src);
    const html = renderSessionDetail(db, "s1", { showTools: true });
    expect(html).toContain("Bash");
    expect(html).toContain("ls");
    expect(html).not.toContain("SECRET_REASONING");
  });

  test("missing source file → warning banner + text-only fallback", () => {
    seedWithFile("s1", join(tempDir, "gone.jsonl")); // never written
    const html = renderSessionDetail(db, "s1", { showThinking: true });
    expect(html).toContain("Original session file unavailable");
    expect(html).not.toContain("SECRET_REASONING");
    expect(html).toContain("Hide thinking"); // control still shown
  });

  test("dimension-specific no-data note: tool data present but no thinking data", () => {
    const toolOnlyJsonl = [
      JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "the question" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [
        { type: "text", text: "the answer" },
        { type: "tool_use", name: "Bash", input: { command: "ls" } },
      ] } }),
    ].join("\n");
    const src = join(tempDir, "tool-only.jsonl"); writeFileSync(src, toolOnlyJsonl);
    seedWithFile("s1", src);

    const html = renderSessionDetail(db, "s1", { showThinking: true, showTools: true });
    expect(html).toContain("Bash"); // tool content actually rendered
    expect(html).toContain("No thinking data for this session.");
    expect(html).not.toContain("No tool data for this session.");
    expect(html).not.toContain("No thinking/tool data for this session.");
  });

  test("toggle links preserve the other param", () => {
    const src = join(tempDir, "s.jsonl"); writeFileSync(src, jsonl);
    seedWithFile("s1", src);

    const htmlToolsOnly = renderSessionDetail(db, "s1", { showTools: true });
    const thinkingLinkMatch = htmlToolsOnly.match(/<a href="([^"]+)">Show thinking<\/a>/);
    expect(thinkingLinkMatch).not.toBeNull();
    expect(thinkingLinkMatch![1]).toContain("tools=1");

    const htmlThinkingOnly = renderSessionDetail(db, "s1", { showThinking: true });
    const toolsLinkMatch = htmlThinkingOnly.match(/<a href="([^"]+)">Show tools<\/a>/);
    expect(toolsLinkMatch).not.toBeNull();
    expect(toolsLinkMatch![1]).toContain("thinking=1");
  });

  test("tool call renders collapsible with name, preview, and paired result", () => {
    const src = join(tempDir, "tool.jsonl");
    writeFileSync(src, [
      JSON.stringify({ type: "assistant", message: { content: [
        { type: "tool_use", id: "tu_9", name: "Bash", input: { command: "ls -la /tmp" } },
      ] } }),
      JSON.stringify({ type: "user", message: { content: [
        { type: "tool_result", tool_use_id: "tu_9", content: "RESULT_PAYLOAD" },
      ] } }),
    ].join("\n"));
    seedWithFile("s1", src);
    const html = renderSessionDetail(db, "s1", { showTools: true });
    expect(html).toContain("<details class=\"transcript-tool\"");
    expect(html).toContain("class=\"tool-name\">Bash");
    expect(html).toContain("ls -la /tmp");                     // preview + input
    expect(html).toContain("RESULT_PAYLOAD");                  // paired result present
    expect((html.match(/RESULT_PAYLOAD/g) || []).length).toBe(1); // not duplicated standalone
  });

  test("long thinking shows a token estimate", () => {
    const src = join(tempDir, "think.jsonl");
    const long = "x".repeat(400);
    writeFileSync(src, JSON.stringify({ type: "assistant", message: { content: [
      { type: "thinking", thinking: long },
    ] } }));
    seedWithFile("s1", src);
    const html = renderSessionDetail(db, "s1", { showThinking: true });
    expect(html).toContain("class=\"transcript-thinking\"");
    expect(html).toContain("tokens");
  });

  test("toolPreview returns per-tool one-liners", () => {
    expect(toolPreview("Bash", { command: "a".repeat(120) }).length).toBe(80);
    expect(toolPreview("Read", { file_path: "/a.ts" })).toBe("/a.ts");
    expect(toolPreview("Grep", { pattern: "foo" })).toBe("foo");
    expect(toolPreview("Task", { description: "do it" })).toBe("do it");
    expect(toolPreview("Unknown", { x: 1 })).toBe("");
    expect(toolPreview(undefined, undefined)).toBe("");
  });
});
