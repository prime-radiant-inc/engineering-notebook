import { readFileSync } from "fs";
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

/** Format a UTC ISO timestamp to HH:MM using UTC hours/minutes */
function formatTime(timestamp: string): string {
  // Use UTC slice to avoid locale/timezone issues
  return timestamp.slice(11, 16);
}

function formatDate(timestamp: string): string {
  return timestamp.slice(0, 10);
}

function extractUserText(content: string | ContentBlock[]): string | null {
  if (typeof content === "string") {
    return content;
  }
  // Skip messages that contain tool_result blocks
  const hasToolResult = content.some((b) => b.type === "tool_result");
  if (hasToolResult) {
    return null;
  }
  const texts = content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!);
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
  let projectPath = "";
  let gitBranch: string | null = null;
  let version: string | null = null;
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;
  const messages: ParsedMessage[] = [];
  let codexFormat = false;
  let assistantDisplayName = "Claude";

  for (const line of lines) {
    let parsed: RawRecord | CodexRecord;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // skip malformed lines
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

    // Track the first sessionId we see to detect continuations
    if (record.sessionId && !firstRecordSessionId) {
      firstRecordSessionId = record.sessionId;
      if (firstRecordSessionId !== fileSessionId) {
        parentSessionId = firstRecordSessionId;
      }
    }

    // For continuation files, skip prefix records from the parent session
    if (parentSessionId && record.sessionId === parentSessionId) {
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

  const projectName = projectNameFromPath(projectPath);
  const userDisplayName = userDisplayNameFromPath(projectPath);
  if (codexFormat && assistantDisplayName === "Claude") {
    assistantDisplayName = "Codex";
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
