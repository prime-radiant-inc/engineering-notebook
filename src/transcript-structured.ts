export type StructuredBlock = { kind:"text"|"thinking"|"tool_use"|"tool_result"; content:string; name?:string; id?:string; toolUseId?:string; input?:Record<string,unknown>; isError?:boolean };
export type StructuredMessage = { role:"user"|"assistant"; uuid?:string; parentUuid?:string|null; timestamp?:string; model?:string; isMeta?:boolean; blocks: StructuredBlock[] };
export type StructuredFormat = "claude"|"codex"|"unknown";

import { resolveActivePath } from "./message-tree";

/**
 * A user message that is purely command *output* (<local-command-stdout>…</…>)
 * is machine-generated noise, not a user turn — hide it (both here and in the
 * ported claude-session-viewer).
 */
export function isCommandOutputMessage(content: unknown): boolean {
  const strip = (t: string) => t.replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "").trim();
  if (typeof content === "string") {
    const t = content.trim();
    return /<local-command-stdout>/.test(t) && strip(t) === "";
  }
  if (Array.isArray(content)) {
    if (content.some((b: any) => b && typeof b === "object" && b.type && b.type !== "text")) return false;
    const text = content.map((b: any) => (b && b.type === "text" && typeof b.text === "string" ? b.text : "")).join("\n").trim();
    return /<local-command-stdout>/.test(text) && strip(text) === "";
  }
  return false;
}

function resultToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b:any)=> b && typeof b==="object" && typeof b.text==="string" ? b.text : JSON.stringify(b)).join("\n");
  if (content == null) return "";
  return JSON.stringify(content, null, 2);
}

export function parseStructuredTranscript(
  jsonlText: string,
  opts: { full?: boolean } = {}
): { messages: StructuredMessage[]; format: StructuredFormat; compacted: boolean } {
  const codexMsgs: StructuredMessage[] = [];
  const claudeMsgs: StructuredMessage[] = [];
  // uuid -> parentUuid for EVERY record (incl. filtered meta/summary/progress),
  // so the active-path resolver can bridge parent chains through them.
  const allParent = new Map<string, string | null>();
  let format: StructuredFormat = "unknown";
  // A compacted session carries an injected "isCompactSummary" record: the full
  // pre-compaction messages live in the same file but are pruned by active-path
  // resolution. "full" mode returns them all and drops the injected summary.
  let compacted = false;

  for (const line of jsonlText.split("\n")) {
    const t = line.trim(); if (!t) continue;
    let rec:any; try { rec = JSON.parse(t); } catch { continue; }

    if (typeof rec?.uuid === "string") allParent.set(rec.uuid, rec.parentUuid ?? null);

    if (rec?.type === "session_meta") { format = "codex"; continue; }
    if (rec?.type === "response_item") {
      const p = rec.payload;
      if (p?.type !== "message" || (p.role !== "user" && p.role !== "assistant")) continue;
      format = "codex";
      const blocks: StructuredBlock[] = [];
      for (const b of Array.isArray(p.content)?p.content:[]) {
        if ((b?.type==="input_text"||b?.type==="output_text") && typeof b.text==="string" && b.text && b.text!=="(no content)") blocks.push({ kind:"text", content:b.text });
      }
      if (blocks.length) codexMsgs.push({ role:p.role, timestamp:rec.timestamp, blocks });
      continue;
    }

    if (rec?.type !== "user" && rec?.type !== "assistant") continue;
    if (rec?.isMeta === true) continue; // matches viewer: skip isMeta nodes (parent chain already recorded above)
    if (rec?.isCompactSummary === true) { compacted = true; if (opts.full) continue; } // in full mode, drop the injected summary
    if (rec?.message == null) continue;
    const role = rec.type as "user"|"assistant";
    const content = rec.message.content;
    if (role === "user" && isCommandOutputMessage(content)) continue; // command output, not a user turn
    const blocks: StructuredBlock[] = [];
    if (typeof content === "string") {
      if (content && content!=="(no content)") blocks.push({ kind:"text", content });
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (!b || typeof b!=="object") continue;
        switch (b.type) {
          case "text": if (typeof b.text==="string" && b.text && b.text!=="(no content)") blocks.push({ kind:"text", content:b.text }); break;
          case "thinking": if (typeof b.thinking==="string") blocks.push({ kind:"thinking", content:b.thinking }); break; // keep empty (signature-only/redacted) thinking; UI shows a marker
          case "tool_use": blocks.push({ kind:"tool_use", name: typeof b.name==="string"?b.name:undefined, id: typeof b.id==="string"?b.id:undefined, input: b.input!=null && typeof b.input==="object"? b.input as Record<string,unknown>:undefined, content: b.input!=null? JSON.stringify(b.input,null,2):"" }); break;
          case "tool_result": blocks.push({ kind:"tool_result", toolUseId: typeof b.tool_use_id==="string"?b.tool_use_id:undefined, content: resultToString(b.content), isError: b.is_error === true ? true : undefined }); break;
        }
      }
    }
    if (format==="unknown") format = "claude";
    const model = typeof rec.message.model === "string" ? rec.message.model : undefined;
    // Create a node for every non-meta user/assistant message (even empty), matching the
    // viewer's buildMessageTree, so the active-path length matches.
    claudeMsgs.push({ role, uuid: rec.uuid, parentUuid: rec.parentUuid ?? null, timestamp: rec.timestamp, model, blocks });
  }

  if (format === "codex") return { messages: codexMsgs, format, compacted };
  // Uncompacted/full: every message in file order. Compacted: the resolved active path.
  return { messages: opts.full ? claudeMsgs : resolveActivePath(claudeMsgs, allParent), format, compacted };
}
