export type TranscriptRole = "user" | "assistant";
export type TranscriptKind = "text" | "thinking" | "tool_use" | "tool_result";
export type TranscriptItem = { role: TranscriptRole; kind: TranscriptKind; content: string; name?: string; id?: string; toolUseId?: string; input?: Record<string, unknown> };
export type TranscriptFormat = "claude" | "codex" | "unknown";

function toolResultToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && typeof (b as any).text === "string" ? (b as any).text : JSON.stringify(b)))
      .join("\n");
  }
  if (content == null) return "";
  return JSON.stringify(content, null, 2);
}

export function parseTranscript(jsonlText: string): { items: TranscriptItem[]; format: TranscriptFormat } {
  const items: TranscriptItem[] = [];
  let format: TranscriptFormat = "unknown";

  for (const line of jsonlText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: any;
    try { rec = JSON.parse(trimmed); } catch { continue; }

    // Codex format
    if (rec?.type === "session_meta") { format = "codex"; continue; }
    if (rec?.type === "response_item") {
      const p = rec.payload;
      if (p?.type !== "message" || (p.role !== "user" && p.role !== "assistant")) continue;
      format = "codex";
      const role = p.role as TranscriptRole;
      for (const b of Array.isArray(p.content) ? p.content : []) {
        if ((b?.type === "input_text" || b?.type === "output_text") && typeof b.text === "string" && b.text && b.text !== "(no content)") {
          items.push({ role, kind: "text", content: b.text });
        }
      }
      continue;
    }

    // Claude Code format
    if (rec?.type !== "user" && rec?.type !== "assistant") continue;
    const role = rec.type as TranscriptRole;
    const content = rec?.message?.content;
    if (typeof content === "string") {
      if (content && content !== "(no content)") { items.push({ role, kind: "text", content }); if (format === "unknown") format = "claude"; }
      continue;
    }
    if (!Array.isArray(content)) continue;
    if (format === "unknown") format = "claude";

    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      switch (b.type) {
        case "text":
          if (typeof b.text === "string" && b.text && b.text !== "(no content)") items.push({ role, kind: "text", content: b.text });
          break;
        case "thinking":
          if (typeof b.thinking === "string" && b.thinking) items.push({ role, kind: "thinking", content: b.thinking });
          break;
        case "tool_use":
          items.push({
            role, kind: "tool_use",
            name: typeof b.name === "string" ? b.name : undefined,
            id: typeof b.id === "string" ? b.id : undefined,
            input: b.input != null && typeof b.input === "object" ? (b.input as Record<string, unknown>) : undefined,
            content: b.input != null ? JSON.stringify(b.input, null, 2) : "",
          });
          break;
        case "tool_result":
          items.push({
            role, kind: "tool_result",
            toolUseId: typeof b.tool_use_id === "string" ? b.tool_use_id : undefined,
            content: toolResultToString(b.content),
          });
          break;
      }
    }
  }

  return { items, format };
}
