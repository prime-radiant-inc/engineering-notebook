import { describe, test, expect } from "bun:test";
import { renderSessionFooter } from "./session";

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
