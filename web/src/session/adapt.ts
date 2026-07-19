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
    return { type: m.role, uuid: m.uuid || `msg-${i}`, timestamp: m.timestamp, model: m.model, isMeta: m.isMeta, content, isToolResult };
  });
}

/** Strip command/caveat wrappers so a slash-command reads like "/plugin marketplace add …". */
export function cleanCommandText(text: string): string {
  let t = text
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "")
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "")
    .trim();
  const name = /<command-name>([^<]*)<\/command-name>/.exec(t)?.[1]?.trim();
  const msg = /<command-message>([^<]*)<\/command-message>/.exec(t)?.[1]?.trim();
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim();
  if (name || msg) {
    return [name || `/${msg}`, args].filter(Boolean).join(" ").trim();
  }
  return t.replace(/<[^>]+>/g, "").trim();
}

/** The session title = first real (non-meta, non-tool-result) user prompt, command-cleaned. */
export function extractTitle(messages: ParsedMessage[]): string {
  for (const m of messages) {
    if (m.type !== "user" || m.isToolResult || m.isMeta) continue;
    const textBlock = m.content.find((b) => b.type === "text");
    if (textBlock && textBlock.type === "text") {
      const cleaned = cleanCommandText(textBlock.text);
      if (cleaned) return cleaned.slice(0, 200);
    }
  }
  return "";
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
