import { readFileSync, statSync } from "fs";
import { basename } from "path";

export type MessageRole = "user" | "assistant";

export type ParsedMessage = {
  role: MessageRole;
  text: string;
  timestamp: string;
};

export type ParsedSession = {
  sessionId: string;
  parentSessionId: string | null;
  projectPath: string;
  projectName: string;
  userDisplayName: string;
  assistantDisplayName: string;
  gitBranch: string | null;
  version: string | null;
  startedAt: string;
  endedAt: string | null;
  messages: ParsedMessage[];
  messageCount: number;
  /**
   * Whether this session is a subagent run, when the format states it
   * outright. Left undefined for Claude Code, whose parentSessionId covers
   * continuations too and so is decided from the file path instead.
   */
  isSubagent?: boolean;
  toMarkdown: () => string;
};

type RawRecord = {
  type: string;
  subtype?: string;
  sessionId?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  message?: {
    role: string;
    content: string | ContentBlock[];
  };
  timestamp?: string;
  uuid?: string;
  isCompactSummary?: boolean;
};

type OpenCodeMetaRecord = {
  type: string;
  timestamp?: string;
  payload?: {
    id?: string;
    cwd?: string;
    title?: string;
    version?: string;
    parent_id?: string | null;
    model?: string | null;
  };
};

type CodexRecord = {
  type: string;
  timestamp?: string;
  payload?: {
    id?: string;
    cwd?: string;
    originator?: string;
    cli_version?: string;
    git?: {
      branch?: string;
    };
    type?: string;
    role?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  };
};

type CursorRecord = {
  role?: string;
  message?: {
    content: string | ContentBlock[];
  };
};

type ContentBlock = {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  tool_use_id?: string;
  [key: string]: unknown;
};

function projectNameFromPath(projectPath: string): string {
  const parts = projectPath.split("/").filter(Boolean);
  return parts[parts.length - 1] || "unknown";
}

function userDisplayNameFromPath(projectPath: string): string {
  const unixHomeMatch = projectPath.match(/^\/(?:Users|home)\/([^/]+)/);
  if (unixHomeMatch?.[1]) return unixHomeMatch[1];

  const windowsHomeMatch = projectPath.match(/^[A-Za-z]:\\Users\\([^\\]+)/);
  if (windowsHomeMatch?.[1]) return windowsHomeMatch[1];

  return "User";
}

/** Cursor stores no cwd. Derive the project from the encoded directory name
 *  that sits immediately before `agent-transcripts/` in the file path. The name
 *  is the raw dash-encoded string and is intentionally NOT decoded — the
 *  encoding is lossy (both `/` and `.` collapse to `-`). See README caveats. */
function cursorProjectFromPath(filePath: string): string {
  const parts = filePath.split("/").filter(Boolean);
  const idx = parts.indexOf("agent-transcripts");
  if (idx > 0) return parts[idx - 1]!;
  return parts.length >= 2 ? parts[parts.length - 2]! : "cursor";
}

/** Format a UTC ISO timestamp to HH:MM using UTC hours/minutes */
function formatTime(timestamp: string): string {
  // Use UTC slice to avoid locale/timezone issues
  return timestamp.slice(11, 16);
}

function formatDate(timestamp: string): string {
  return timestamp.slice(0, 10);
}

/** Clean up command-message XML tags from slash command messages.
 *  e.g. "<command-message>brainstorm</command-message>\n<command-args>fix the bug</command-args>"
 *  becomes "/brainstorm fix the bug" */
function cleanCommandTags(text: string): string {
  if (!text.includes("<command-message>")) return text;
  const cmdMatch = text.match(/<command-message>([^<]*)<\/command-message>/);
  if (!cmdMatch) return text;
  const commandName = cmdMatch[1]!;
  const argsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  const args = argsMatch?.[1]?.trim() || "";
  return args ? `/${commandName} ${args}` : `/${commandName}`;
}

function extractUserText(content: string | ContentBlock[]): string | null {
  if (typeof content === "string") {
    return cleanCommandTags(content);
  }
  // Skip messages that contain tool_result blocks
  const hasToolResult = content.some((b) => b.type === "tool_result");
  if (hasToolResult) {
    return null;
  }
  const texts = content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => cleanCommandTags(b.text!));
  return texts.length > 0 ? texts.join("\n") : null;
}

function extractAssistantText(content: string | ContentBlock[]): string | null {
  if (typeof content === "string") {
    return content === "(no content)" ? null : content;
  }
  // Only extract text blocks — skip thinking, tool_use, and everything else
  const texts = content
    .filter((b) => b.type === "text" && b.text && b.text !== "(no content)")
    .map((b) => b.text!);
  return texts.length > 0 ? texts.join("\n") : null;
}

function extractCodexText(
  content: Array<{ type?: string; text?: string }> | undefined,
  role: "user" | "assistant"
): string | null {
  if (!content || content.length === 0) return null;
  const type = role === "user" ? "input_text" : "output_text";
  const texts = content
    .filter((b) => b.type === type && b.text && b.text !== "(no content)")
    .map((b) => b.text!.trim())
    .filter(Boolean);
  return texts.length > 0 ? texts.join("\n") : null;
}

function isCodexBoilerplateUserMessage(text: string): boolean {
  return (
    text.startsWith("# AGENTS.md instructions for ") ||
    text.startsWith("<environment_context>") ||
    text.includes("<environment_context>")
  );
}

export function parseSession(filePath: string): ParsedSession {
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.trim().split("\n").filter(Boolean);

  // Default to file basename for compatibility; overwritten when available.
  const fileSessionId = basename(filePath, ".jsonl");
  let sessionId = fileSessionId;

  let firstRecordSessionId: string | null = null;
  let parentSessionId: string | null = null;
  let continuationParentId: string | null = null;
  let projectPath = "";
  let gitBranch: string | null = null;
  let version: string | null = null;
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;
  const messages: ParsedMessage[] = [];
  let codexFormat = false;
  let cursorFormat = false;
  let openCodeFormat = false;
  let assistantDisplayName = "Claude";

  for (const line of lines) {
    let parsed: RawRecord | CodexRecord;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // skip malformed lines
    }

    // OpenCode sessions are staged by the adapter as an `opencode_meta` header
    // followed by Claude-Code-shaped message records, so only the header needs
    // handling here — the message records fall through to the normal path.
    const openCodeRecord = parsed as OpenCodeMetaRecord;
    if (openCodeRecord.type === "opencode_meta") {
      assistantDisplayName = "OpenCode";
      openCodeFormat = true;

      if (openCodeRecord.timestamp) {
        if (!firstTimestamp) firstTimestamp = openCodeRecord.timestamp;
        lastTimestamp = openCodeRecord.timestamp;
      }

      const payload = openCodeRecord.payload;
      if (payload?.id) sessionId = payload.id;
      if (payload?.cwd && !projectPath) projectPath = payload.cwd;
      if (payload?.version && !version) version = payload.version;
      if (payload?.parent_id) parentSessionId = payload.parent_id;
      continue;
    }

    const codexRecord = parsed as CodexRecord;
    if (codexRecord.type === "session_meta" || codexFormat) {
      codexFormat = true;

      if (codexRecord.timestamp) {
        if (!firstTimestamp) firstTimestamp = codexRecord.timestamp;
        lastTimestamp = codexRecord.timestamp;
      }

      if (codexRecord.type === "session_meta") {
        if (codexRecord.payload?.originator?.toLowerCase().includes("codex")) {
          assistantDisplayName = "Codex";
        }
        if (codexRecord.payload?.id) sessionId = codexRecord.payload.id;
        if (codexRecord.payload?.cwd && !projectPath) projectPath = codexRecord.payload.cwd;
        if (codexRecord.payload?.cli_version && !version) version = codexRecord.payload.cli_version;
        if (codexRecord.payload?.git?.branch && !gitBranch) {
          gitBranch = codexRecord.payload.git.branch;
        }
        continue;
      }

      if (codexRecord.type !== "response_item") continue;
      if (codexRecord.payload?.type !== "message") continue;
      if (codexRecord.payload.role !== "user" && codexRecord.payload.role !== "assistant") {
        continue;
      }

      const role = codexRecord.payload.role as "user" | "assistant";
      const text = extractCodexText(codexRecord.payload.content, role);
      if (!text) continue;
      if (role === "user" && isCodexBoilerplateUserMessage(text)) continue;

      messages.push({
        role,
        text,
        timestamp: codexRecord.timestamp || "",
      });
      continue;
    }

    const record = parsed as RawRecord;

    // Cursor format: a top-level `role` with a `message`, and no `type` field.
    // Content blocks share Claude's shape, so reuse the existing extractors.
    // Project and timestamps are derived after the loop (Cursor records carry
    // neither).
    if (!record.type && record.message) {
      const cursor = parsed as CursorRecord;
      if (cursor.role === "user" || cursor.role === "assistant") {
        cursorFormat = true;
        const text =
          cursor.role === "user"
            ? extractUserText(record.message.content)
            : extractAssistantText(record.message.content);
        if (text) {
          messages.push({ role: cursor.role, text, timestamp: "" });
        }
        continue;
      }
    }

    // Track the first sessionId we see to detect continuations.
    // Subagent files (path contains /subagents/) always have the parent's
    // sessionId in every record — this is expected, not a continuation.
    const isSubagentFile = filePath.includes("/subagents/");
    if (record.sessionId && !firstRecordSessionId) {
      firstRecordSessionId = record.sessionId;
      if (firstRecordSessionId !== fileSessionId) {
        // The link back to the originating session — recorded for BOTH
        // subagents and continuations.
        parentSessionId = firstRecordSessionId;
        // Only true continuations replay the parent's records as a prefix to
        // skip. A subagent's own records all carry the parent's sessionId, so
        // skipping them would erase the whole transcript.
        if (!isSubagentFile) continuationParentId = firstRecordSessionId;
      }
    }

    // For continuation files, skip prefix records from the parent session
    if (continuationParentId && record.sessionId === continuationParentId) {
      continue;
    }

    // Skip synthetic compact summary messages
    if (record.isCompactSummary) {
      continue;
    }

    // Track timestamps only for this session's own records
    if (record.timestamp) {
      if (!firstTimestamp) firstTimestamp = record.timestamp;
      lastTimestamp = record.timestamp;
    }

    // Extract metadata from this session's own records
    if (record.cwd && !projectPath) projectPath = record.cwd;
    if (record.gitBranch && !gitBranch) gitBranch = record.gitBranch;
    if (record.version && !version) version = record.version;

    // Only process user and assistant message records
    if (record.type !== "user" && record.type !== "assistant") continue;
    if (!record.message) continue;

    const timestamp = record.timestamp || "";

    if (record.type === "user") {
      const text = extractUserText(record.message.content);
      if (text) {
        messages.push({ role: "user", text, timestamp });
      }
    } else if (record.type === "assistant") {
      const text = extractAssistantText(record.message.content);
      if (text) {
        messages.push({ role: "assistant", text, timestamp });
      }
    }
  }

  let projectName = projectNameFromPath(projectPath);
  let userDisplayName = userDisplayNameFromPath(projectPath);
  if (codexFormat && assistantDisplayName === "Claude") {
    assistantDisplayName = "Codex";
  }

  if (cursorFormat) {
    assistantDisplayName = "Cursor";
    const dir = cursorProjectFromPath(filePath);
    projectName = dir;
    projectPath = dir;
    userDisplayName = "User";

    // Cursor transcripts have no timestamps; fall back to file times.
    const stat = statSync(filePath);
    const birth = stat.birthtime.getTime() ? stat.birthtime : stat.mtime;
    firstTimestamp = birth.toISOString();
    lastTimestamp = stat.mtime.toISOString();
    for (const msg of messages) {
      msg.timestamp = firstTimestamp;
    }
  }

  return {
    sessionId,
    parentSessionId,
    projectPath,
    projectName,
    userDisplayName,
    assistantDisplayName,
    gitBranch,
    version,
    startedAt: firstTimestamp || "",
    endedAt: lastTimestamp || null,
    messages,
    messageCount: messages.length,
    isSubagent: openCodeFormat ? parentSessionId !== null : undefined,
    toMarkdown() {
      const startTime = firstTimestamp ? formatTime(firstTimestamp) : "??:??";
      const endTime = lastTimestamp ? formatTime(lastTimestamp) : "??:??";
      const date = firstTimestamp ? formatDate(firstTimestamp) : "unknown";

      let md = `# Session: ${projectName}\n`;
      md += `**Date:** ${date} ${startTime} - ${endTime}`;
      if (gitBranch) md += ` | **Branch:** ${gitBranch}`;
      md += ` | **Project:** ${projectPath}\n\n---\n\n`;

      for (const msg of messages) {
        const time = msg.timestamp.slice(0, 16).replace("T", " ");
        const speaker = msg.role === "user" ? userDisplayName : assistantDisplayName;
        const firstLine = msg.text.split("\n")[0];
        const truncated = msg.text.includes("\n")
          ? firstLine + " [...]"
          : firstLine;
        md += `**${speaker} (${time}):** ${truncated}\n`;
      }

      return md;
    },
  };
}
