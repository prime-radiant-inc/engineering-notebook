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

interface SubagentContext { subagentMap: Record<string, string>; sessionId: string; onOpenSubagent?: (sessionId: string) => void }
interface RenderContext { subagentCtx?: SubagentContext; showToolCalls: boolean; showThinking: boolean; toolResultMap: Map<string, ToolResultEntry>; focusToolUseId?: string }

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
      const agentId = ctx.subagentCtx?.subagentMap[block.id];
      // Highlight ring when this is the spawn point we navigated back to.
      const focused = !!agentId && ctx.focusToolUseId === block.id;
      const ring = focused ? " ring-2 ring-teal rounded-lg" : "";
      if (!ctx.showToolCalls) {
        // Even with tools hidden, keep subagent spawn points visible as a
        // navigation link — they connect the parent to its subagents. A spawn
        // is identified by the block id being in the subagent map, NOT by tool
        // name (Claude Code names it "Agent"; other builds use "Task").
        if (agentId && ctx.subagentCtx?.onOpenSubagent) {
          const open = ctx.subagentCtx.onOpenSubagent;
          const title = String((block.input as Record<string, unknown>).description || "subagent");
          return (
            <button
              id={`spawn-${block.id}`}
              key={index}
              onClick={() => open(`agent-${agentId}`)}
              className={`text-xs text-teal hover:text-ink flex items-center gap-1 my-1 px-1${ring}`}
              title="Open this subagent's transcript in panel 3"
            >
              <span aria-hidden>🤖</span>
              <span className="underline">{title}</span>
              <span aria-hidden>↗</span>
            </button>
          );
        }
        return null;
      }
      const result = ctx.toolResultMap.get(block.id);
      const el = <ToolCallInline key={index} name={block.name} id={block.id} input={block.input} result={result} subagentCtx={ctx.subagentCtx} />;
      // Anchor spawn tool calls so the backlink can scroll to them.
      if (agentId) return <div id={`spawn-${block.id}`} key={index} className={ring ? ring.trimStart() : undefined}>{el}</div>;
      return el;
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
  onOpenSubagent?: (sessionId: string) => void;
  focusToolUseId?: string;
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
  onOpenSubagent,
  focusToolUseId,
  showToolCalls = true,
  showThinking = true,
  userName,
  assistantLabel,
}: MessageBlockProps) {
  const isUser = message.type === "user";
  const subagentCtx = subagentMap && sessionId ? { subagentMap, sessionId, onOpenSubagent } : undefined;
  const ctx: RenderContext = { subagentCtx, showToolCalls, showThinking, toolResultMap, focusToolUseId };

  if (isConsumedToolResult) return null;

  const hasVisibleContent = message.content.some((block) => {
    if (block.type === "thinking") return showThinking;
    if (block.type === "tool_use") {
      if (showToolCalls) return true;
      // A subagent spawn point stays visible as a navigation link (matched by id).
      return !!subagentCtx?.subagentMap[block.id] && !!subagentCtx?.onOpenSubagent;
    }
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
