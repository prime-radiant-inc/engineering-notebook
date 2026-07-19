import { describe, test, expect } from "bun:test";
import { parseStructuredTranscript } from "./transcript-structured";

test("groups blocks under messages, preserving ids and threading", () => {
  const lines = [
    JSON.stringify({ type:"assistant", uuid:"u1", parentUuid:null, timestamp:"t1", message:{ content:[
      { type:"thinking", thinking:"th" },
      { type:"text", text:"hi" },
      { type:"tool_use", id:"tu1", name:"Bash", input:{ command:"ls" } },
    ] } }),
    JSON.stringify({ type:"user", uuid:"u2", parentUuid:"u1", timestamp:"t2", message:{ content:[
      { type:"tool_result", tool_use_id:"tu1", content:"out" },
    ] } }),
  ].join("\n");
  const { messages, format } = parseStructuredTranscript(lines);
  expect(format).toBe("claude");
  expect(messages).toHaveLength(2);
  expect(messages[0]).toMatchObject({ role:"assistant", uuid:"u1", parentUuid:null, timestamp:"t1" });
  expect(messages[0]!.blocks.map(b=>b.kind)).toEqual(["thinking","text","tool_use"]);
  expect(messages[0]!.blocks[2]).toMatchObject({ kind:"tool_use", id:"tu1", name:"Bash", input:{ command:"ls" } });
  expect(messages[1]!.blocks[0]).toMatchObject({ kind:"tool_result", toolUseId:"tu1", content:"out" });
});

test("empty → no messages, unknown", () => {
  expect(parseStructuredTranscript("")).toEqual({ messages: [], format: "unknown" });
});
