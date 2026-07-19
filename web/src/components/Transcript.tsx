import { Fragment } from "react";
import type { StructuredMessage, Subagent } from "../api";
import { MessageText } from "./MessageBlock";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallBlock } from "./ToolCallBlock";
import { SubagentPanel } from "./SubagentPanel";

export function Transcript({
  messages,
  subagents,
  sessionId,
  showThinking,
  showTools,
}: {
  messages: StructuredMessage[];
  subagents: Subagent[];
  sessionId: string;
  showThinking: boolean;
  showTools: boolean;
}) {
  // Pair tool_results to their tool_use (order-independent) and index subagents by their spawning tool_use.
  const resultsByToolUseId = new Map<string, string>();
  const toolUseIds = new Set<string>();
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.kind === "tool_result" && b.toolUseId && !resultsByToolUseId.has(b.toolUseId)) resultsByToolUseId.set(b.toolUseId, b.content);
      if (b.kind === "tool_use" && b.id) toolUseIds.add(b.id);
    }
  }
  const subagentByToolUseId = new Map<string, Subagent>();
  for (const sa of subagents) if (sa.toolUseId) subagentByToolUseId.set(sa.toolUseId, sa);

  let hadThinking = false;
  let hadTool = false;
  const out: React.ReactNode[] = [];

  messages.forEach((m, mi) => {
    m.blocks.forEach((b, bi) => {
      const key = `${mi}-${bi}`;
      if (b.kind === "text") {
        out.push(<MessageText key={key} role={m.role} content={b.content} />);
      } else if (b.kind === "thinking") {
        hadThinking = true;
        if (showThinking) out.push(<ThinkingBlock key={key} content={b.content} />);
      } else if (b.kind === "tool_use") {
        hadTool = true;
        if (showTools) {
          const result = b.id ? resultsByToolUseId.get(b.id) : undefined;
          const sa = b.id ? subagentByToolUseId.get(b.id) : undefined;
          out.push(
            <Fragment key={key}>
              <ToolCallBlock name={b.name} input={b.input} body={b.content} result={result} />
              {sa && (
                <SubagentPanel
                  sessionId={sessionId}
                  agentId={sa.agentId}
                  description={sa.description}
                  agentType={sa.agentType}
                  showThinking={showThinking}
                  showTools={showTools}
                />
              )}
            </Fragment>,
          );
        }
      } else if (b.kind === "tool_result") {
        hadTool = true;
        // Rendered inside its tool_use; only render standalone if orphaned.
        if (showTools && !(b.toolUseId && toolUseIds.has(b.toolUseId))) {
          out.push(
            <div key={key} className="border border-stone-200 rounded-lg px-3 py-1.5 my-2 text-xs">
              <div className="text-stone-400">&#8627; result</div>
              <pre className="whitespace-pre-wrap font-mono text-[11px] mt-1 mb-0">{b.content}</pre>
            </div>,
          );
        }
      }
    });
  });

  return (
    <div>
      {out}
      {showThinking && !hadThinking && <p className="text-xs text-stone-400 italic">No thinking data for this session.</p>}
      {showTools && !hadTool && <p className="text-xs text-stone-400 italic">No tool data for this session.</p>}
    </div>
  );
}
