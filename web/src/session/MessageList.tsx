import { useMemo } from "react";
import type { ParsedMessage } from "./types";
import { MessageBlock } from "./MessageBlock";
import { buildToolResultMap, buildContinuationFlags } from "./adapt";

export function MessageList({
  messages,
  subagentMap,
  sessionId,
  showThinking,
  showTools,
  userName,
  assistantLabel,
}: {
  messages: ParsedMessage[];
  subagentMap?: Record<string, string>;
  sessionId: string;
  showThinking: boolean;
  showTools: boolean;
  userName?: string;
  assistantLabel?: string;
}) {
  // Match claude-session-viewer's buildConversationThread: skip only isMeta records.
  const shown = useMemo(() => messages.filter((m) => !m.isMeta), [messages]);
  const { toolResultMap, consumedUuids } = useMemo(() => buildToolResultMap(shown), [shown]);
  const continuationFlags = useMemo(() => buildContinuationFlags(shown), [shown]);

  return (
    <div className="space-y-3">
      {shown.map((msg, i) => (
        <MessageBlock
          key={msg.uuid}
          message={msg}
          isContinuation={continuationFlags[i]}
          isConsumedToolResult={consumedUuids.has(msg.uuid)}
          toolResultMap={toolResultMap}
          subagentMap={subagentMap}
          sessionId={sessionId}
          showToolCalls={showTools}
          showThinking={showThinking}
          userName={userName}
          assistantLabel={assistantLabel}
        />
      ))}
    </div>
  );
}
