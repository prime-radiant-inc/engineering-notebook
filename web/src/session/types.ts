// Display types for the ported viewer components (subset of claude-session-viewer's).
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface ParsedMessage {
  type: "user" | "assistant";
  uuid: string;
  timestamp?: string;
  model?: string;
  isMeta?: boolean;
  content: ContentBlock[];
  isToolResult: boolean;
}

export interface ToolResultEntry {
  content: string;
  isError: boolean;
}
