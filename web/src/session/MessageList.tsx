import { useEffect, useMemo, useRef, useState } from "react";
import type { ParsedMessage } from "./types";
import { MessageBlock } from "./MessageBlock";
import { buildToolResultMap, buildContinuationFlags } from "./adapt";

// Render in bounded batches so a large transcript doesn't freeze on first paint
// or when toggling thinking/tools; grow as the reader scrolls to the bottom.
const BATCH = 80;

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

  const [limit, setLimit] = useState(BATCH);
  useEffect(() => { setLimit(BATCH); }, [shown]);

  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setLimit((l) => Math.min(l + BATCH, shown.length));
    });
    io.observe(el);
    return () => io.disconnect();
  }, [shown.length, limit]);

  const visible = shown.slice(0, limit);

  return (
    <div className="space-y-3">
      {visible.map((msg, i) => (
        <MessageBlock
          key={msg.uuid || i}
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
      {limit < shown.length && (
        <div ref={sentinelRef} className="py-4 text-center text-xs text-slate/70">
          Loading more… ({limit}/{shown.length})
        </div>
      )}
    </div>
  );
}
