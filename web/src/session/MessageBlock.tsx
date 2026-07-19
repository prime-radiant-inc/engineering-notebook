// Ported from claude-session-viewer (app/components/session/MessageBlock.tsx).
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ParsedMessage, ContentBlock, ToolResultEntry } from "./types";
import { formatModelName } from "./format";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallInline } from "./ToolCallInline";
import { XmlView, containsXml } from "./XmlBlock";

function formatTimestamp(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

interface SubagentContext { subagentMap: Record<string, string>; sessionId: string }
interface RenderContext { subagentCtx?: SubagentContext; showToolCalls: boolean; showThinking: boolean; toolResultMap: Map<string, ToolResultEntry> }

function renderContentBlock(block: ContentBlock, index: number, ctx: RenderContext) {
  switch (block.type) {
    case "thinking":
      if (!ctx.showThinking) return null;
      return <ThinkingBlock key={index} content={block.thinking} />;
    case "text":
      if (containsXml(block.text)) return <XmlView key={index} text={block.text} />;
      return (
        <div key={index} className="prose prose-sm max-w-none text-ink">
          <Markdown remarkPlugins={[remarkGfm]}>{block.text}</Markdown>
        </div>
      );
    case "tool_use": {
      if (!ctx.showToolCalls) return null;
      const result = ctx.toolResultMap.get(block.id);
      return <ToolCallInline key={index} name={block.name} id={block.id} input={block.input} result={result} subagentCtx={ctx.subagentCtx} />;
    }
    case "tool_result":
      return null;
    default:
      return null;
  }
}

const EMPTY_RESULT_MAP = new Map<string, ToolResultEntry>();

interface MessageBlockProps {
  message: ParsedMessage;
  isContinuation?: boolean;
  isConsumedToolResult?: boolean;
  toolResultMap?: Map<string, ToolResultEntry>;
  subagentMap?: Record<string, string>;
  sessionId?: string;
  showToolCalls?: boolean;
  showThinking?: boolean;
  userName?: string;
  assistantLabel?: string;
}

export function MessageBlock({
  message,
  isContinuation = false,
  isConsumedToolResult = false,
  toolResultMap = EMPTY_RESULT_MAP,
  subagentMap,
  sessionId,
  showToolCalls = true,
  showThinking = true,
  userName,
  assistantLabel,
}: MessageBlockProps) {
  const isUser = message.type === "user";
  const subagentCtx = subagentMap && sessionId ? { subagentMap, sessionId } : undefined;
  const ctx: RenderContext = { subagentCtx, showToolCalls, showThinking, toolResultMap };

  if (isConsumedToolResult) return null;

  const hasVisibleContent = message.content.some((block) => {
    if (block.type === "thinking") return showThinking;
    if (block.type === "tool_use") return showToolCalls;
    if (block.type === "tool_result") return false;
    if (block.type === "text") return true;
    return true;
  });
  if (!isUser && !hasVisibleContent) return null;

  const displayName = isUser ? (userName || "You") : (assistantLabel || "Assistant");

  const header = !isContinuation && (
    <div className="flex items-center gap-2 mb-1 -ml-2">
      <span className={isUser ? "section-label text-ink" : "section-label text-slate/60"}>{displayName}</span>
      {!isUser && message.model && <span className="text-xs text-slate/50">{formatModelName(message.model)}</span>}
      {message.timestamp && <span className="text-xs text-slate/50 ml-auto">{formatTimestamp(message.timestamp)}</span>}
    </div>
  );

  return (
    <div>
      {isUser && header}
      <div className={isUser ? "bg-white -mx-3 px-3 py-2 rounded-lg shadow-sm border border-edge/30" : ""}>
        {!isUser && header}
        <div className="space-y-2">
          {message.content.map((block, i) => renderContentBlock(block, i, ctx))}
        </div>
      </div>
    </div>
  );
}
