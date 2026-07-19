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

test("resolves the active branch through parentUuid (abandoned forks dropped)", () => {
  // root u1 -> u2 -> (u3a abandoned early) and (u3b -> u4 newer). Active path = u1,u2,u3b,u4.
  const lines = [
    JSON.stringify({ type:"user", uuid:"u1", parentUuid:null, timestamp:"2026-01-01T00:00:00Z", message:{content:"start"} }),
    JSON.stringify({ type:"assistant", uuid:"u2", parentUuid:"u1", timestamp:"2026-01-01T00:00:01Z", message:{content:[{type:"text",text:"ok"}]} }),
    JSON.stringify({ type:"user", uuid:"u3a", parentUuid:"u2", timestamp:"2026-01-01T00:00:02Z", message:{content:"abandoned branch"} }),
    JSON.stringify({ type:"user", uuid:"u3b", parentUuid:"u2", timestamp:"2026-01-01T00:00:03Z", message:{content:"kept branch"} }),
    JSON.stringify({ type:"assistant", uuid:"u4", parentUuid:"u3b", timestamp:"2026-01-01T00:00:04Z", message:{content:[{type:"text",text:"final"}]} }),
  ].join("\n");
  const { messages } = parseStructuredTranscript(lines);
  expect(messages.map((m) => m.uuid)).toEqual(["u1", "u2", "u3b", "u4"]);
});

test("bridges parent chains through filtered (isMeta/summary) records", () => {
  const lines = [
    JSON.stringify({ type:"user", uuid:"a", parentUuid:null, timestamp:"t1", message:{content:"hi"} }),
    JSON.stringify({ type:"summary", uuid:"s", parentUuid:"a", timestamp:"t2", summary:"x" }),
    JSON.stringify({ type:"assistant", uuid:"b", parentUuid:"s", timestamp:"t3", message:{content:[{type:"text",text:"reply"}]} }),
  ].join("\n");
  const { messages } = parseStructuredTranscript(lines);
  // 'b' bridges through the summary record 's' to parent 'a' -> single path a,b
  expect(messages.map((m) => m.uuid)).toEqual(["a", "b"]);
});

test("hides user messages that are purely local-command-stdout (command output)", () => {
  const lines = [
    JSON.stringify({ type:"user", uuid:"u1", parentUuid:null, timestamp:"t1", message:{content:"real prompt"} }),
    JSON.stringify({ type:"user", uuid:"u2", parentUuid:"u1", timestamp:"t2", message:{content:"<local-command-stdout>Successfully added</local-command-stdout>"} }),
    JSON.stringify({ type:"assistant", uuid:"u3", parentUuid:"u2", timestamp:"t3", message:{content:[{type:"text",text:"ok"}]} }),
  ].join("\n");
  const { messages } = parseStructuredTranscript(lines);
  // u2 (command output) is dropped; u3 bridges through it to u1 → path u1,u3
  expect(messages.map((m) => m.uuid)).toEqual(["u1", "u3"]);
});
