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
  onOpenSubagent,
  focusToolUseId,
  showThinking,
  showTools,
  userName,
  assistantLabel,
}: {
  messages: ParsedMessage[];
  subagentMap?: Record<string, string>;
  sessionId: string;
  onOpenSubagent?: (sessionId: string) => void;
  focusToolUseId?: string;
  showThinking: boolean;
  showTools: boolean;
  userName?: string;
  assistantLabel?: string;
}) {
  // Match claude-session-viewer's buildConversationThread: skip only isMeta records.
  const shown = useMemo(() => messages.filter((m) => !m.isMeta), [messages]);
  const { toolResultMap, consumedUuids } = useMemo(() => buildToolResultMap(shown), [shown]);
  const continuationFlags = useMemo(() => buildContinuationFlags(shown), [shown]);

  // Index of the message carrying the spawn tool_use we want to scroll to.
  const focusIndex = useMemo(() => {
    if (!focusToolUseId) return -1;
    return shown.findIndex((m) => m.content.some((b) => b.type === "tool_use" && b.id === focusToolUseId));
  }, [shown, focusToolUseId]);

  // Grow the initial batch to include the focus target so it can be scrolled to.
  const [limit, setLimit] = useState(BATCH);
  // Reset the window only when the conversation changes...
  useEffect(() => { setLimit(BATCH); }, [shown]);
  // ...and GROW it (never shrink) to include a focus target so it can be scrolled to.
  useEffect(() => { if (focusIndex >= 0) setLimit((l) => Math.max(l, focusIndex + 3)); }, [focusIndex]);

  // Scroll to the focus target ONCE per target. Keeping `limit` in deps lets us
  // retry until the (batched-in) element exists, but the ref guard prevents
  // re-scrolling on later batch growth — otherwise scrolling down would yank the
  // reader back to the spawn point every time the list grew.
  const scrolledFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!focusToolUseId) { scrolledFor.current = undefined; return; }
    if (focusIndex < 0 || scrolledFor.current === focusToolUseId) return;
    const el = document.getElementById(`spawn-${focusToolUseId}`);
    if (el) {
      if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center", behavior: "smooth" });
      scrolledFor.current = focusToolUseId;
    }
  }, [focusIndex, limit, focusToolUseId]);

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
          onOpenSubagent={onOpenSubagent}
          focusToolUseId={focusToolUseId}
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
