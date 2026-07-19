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
  const { toolResultMap, consumedUuids } = useMemo(() => buildToolResultMap(messages), [messages]);
  const continuationFlags = useMemo(() => buildContinuationFlags(messages), [messages]);

  return (
    <div className="space-y-3">
      {messages.map((msg, i) => (
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
