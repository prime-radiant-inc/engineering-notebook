import type { StructuredMessage, Subagent } from "../api";
import type { ContentBlock, ParsedMessage, ToolResultEntry } from "./types";

/** Map the API's StructuredMessage[] to the viewer's ParsedMessage[]. */
export function toParsedMessages(messages: StructuredMessage[]): ParsedMessage[] {
  return messages.map((m, i): ParsedMessage => {
    const content: ContentBlock[] = m.blocks.map((b): ContentBlock => {
      switch (b.kind) {
        case "text": return { type: "text", text: b.content };
        case "thinking": return { type: "thinking", thinking: b.content };
        case "tool_use": return { type: "tool_use", id: b.id ?? "", name: b.name ?? "tool", input: b.input ?? {} };
        case "tool_result": return { type: "tool_result", tool_use_id: b.toolUseId ?? "", content: b.content, is_error: b.isError };
      }
    });
    const isToolResult = content.length > 0 && content.every((b) => b.type === "tool_result");
    return { type: m.role, uuid: m.uuid || `msg-${i}`, timestamp: m.timestamp, model: m.model, content, isToolResult };
  });
}

/** subagentMap: tool_use id -> agentId, from the session's subagents. */
export function toSubagentMap(subagents: Subagent[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const sa of subagents) if (sa.toolUseId) map[sa.toolUseId] = sa.agentId;
  return map;
}

/** Build the tool_use_id -> result map and the set of fully-consumed message uuids. */
export function buildToolResultMap(messages: ParsedMessage[]): { toolResultMap: Map<string, ToolResultEntry>; consumedUuids: Set<string> } {
  const map = new Map<string, ToolResultEntry>();
  const consumed = new Set<string>();
  for (const msg of messages) {
    if (!msg.isToolResult) continue;
    let allConsumed = true;
    for (const block of msg.content) {
      if (block.type === "tool_result") map.set(block.tool_use_id, { content: block.content, isError: block.is_error ?? false });
      else allConsumed = false;
    }
    if (allConsumed) consumed.add(msg.uuid);
  }
  return { toolResultMap: map, consumedUuids: consumed };
}

/** Continuation flags: consecutive same-role turns drop their header (viewer's logic). */
export function buildContinuationFlags(messages: ParsedMessage[]): boolean[] {
  const flags = new Array(messages.length).fill(false) as boolean[];
  const first = messages[0];
  let expectAssistantHeader = first?.type === "user" && !first?.isToolResult;
  for (let i = 1; i < messages.length; i++) {
    const msg = messages[i]!;
    const isRealUserMessage = msg.type === "user" && !msg.isToolResult;
    if (isRealUserMessage) { flags[i] = false; expectAssistantHeader = true; }
    else if (expectAssistantHeader && msg.type === "assistant") { flags[i] = false; expectAssistantHeader = false; }
    else flags[i] = true;
  }
  return flags;
}
