import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { discoverSubagents, subagentFilePath } from "./subagents";

describe("discoverSubagents", () => {
  let tempDir: string;
  const sessionId = "sess-1";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "subagents-"));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns [] when subagents dir is missing", () => {
    expect(discoverSubagents(tempDir, sessionId)).toEqual([]);
  });

  test("parses meta.json fields and includes meta-less agents, sorted deterministically", () => {
    const dir = join(tempDir, sessionId, "subagents");
    mkdirSync(dir, { recursive: true });

    // agent with full meta
    writeFileSync(join(dir, "agent-bbb.jsonl"), JSON.stringify({ type: "assistant" }) + "\n");
    writeFileSync(
      join(dir, "agent-bbb.meta.json"),
      JSON.stringify({
        agentType: "general-purpose",
        description: "Investigate widget bug",
        toolUseId: "toolu_123",
        spawnDepth: 1,
      })
    );

    // agent with no meta file at all
    writeFileSync(join(dir, "agent-aaa.jsonl"), JSON.stringify({ type: "assistant" }) + "\n");

    const result = discoverSubagents(tempDir, sessionId);

    expect(result).toEqual([
      { agentId: "aaa" },
      {
        agentId: "bbb",
        agentType: "general-purpose",
        description: "Investigate widget bug",
        toolUseId: "toolu_123",
        spawnDepth: 1,
      },
    ]);
  });

  test("ignores malformed meta.json and still lists the agent by id", () => {
    const dir = join(tempDir, sessionId, "subagents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent-ccc.jsonl"), JSON.stringify({ type: "assistant" }) + "\n");
    writeFileSync(join(dir, "agent-ccc.meta.json"), "{ not valid json");

    expect(discoverSubagents(tempDir, sessionId)).toEqual([{ agentId: "ccc" }]);
  });
});

describe("subagentFilePath", () => {
  test("builds the expected agent jsonl path", () => {
    expect(subagentFilePath("/proj", "sess-1", "abc")).toBe(
      join("/proj", "sess-1", "subagents", "agent-abc.jsonl")
    );
  });
});
