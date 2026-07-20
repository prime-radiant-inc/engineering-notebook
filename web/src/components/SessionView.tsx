import { useEffect, useMemo, useState } from "react";
import { getSession, getTranscript, type SessionMeta, type Transcript as TranscriptData } from "../api";
import { MessageList } from "../session/MessageList";
import { SubagentIndex } from "./SubagentIndex";
import { toParsedMessages, toSubagentMap, extractTitle } from "../session/adapt";
import { useTranscriptToggles } from "../session/toggleContext";

// Panel-3 session viewer — a faithful port of claude-session-viewer's display.
export function SessionView({ id, onOpenSession, focusToolUseId }: { id: string; onOpenSession?: (id: string, focusToolUseId?: string) => void; focusToolUseId?: string }) {
  const [meta, setMeta] = useState<SessionMeta | null>(null);
  const [data, setData] = useState<TranscriptData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { showThinking, showTools } = useTranscriptToggles();

  useEffect(() => {
    setLoading(true);
    setError(null);
    setMeta(null);
    setData(null);
    Promise.all([getSession(id), getTranscript(id)])
      .then(([m, t]) => { setMeta(m); setData(t); })
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setLoading(false));
  }, [id]);

  const messages = useMemo(() => (data ? toParsedMessages(data.messages) : []), [data]);
  const subagentMap = useMemo(() => (meta ? toSubagentMap(meta.subagents) : {}), [meta]);
  const firstPrompt = useMemo(() => extractTitle(messages), [messages]);

  // Is the spawn point we want to focus actually present on the active transcript?
  // If not (compacted away), fall back to highlighting it in the Subagents index.
  const focusInTranscript = useMemo(
    () => !!focusToolUseId && messages.some((m) => m.content.some((b) => b.type === "tool_use" && b.id === focusToolUseId)),
    [messages, focusToolUseId],
  );

  // The highlight ring fades a few seconds after the transcript loads, so it
  // flashes to locate the spawn point rather than lingering indefinitely.
  const [focusActive, setFocusActive] = useState<string | undefined>(focusToolUseId);
  useEffect(() => {
    setFocusActive(focusToolUseId);
    if (!focusToolUseId || !data) return;
    const t = setTimeout(() => setFocusActive(undefined), 4000);
    return () => clearTimeout(t);
  }, [focusToolUseId, data, id]);

  return (
    <div className="max-w-4xl">
      <div className="mb-6">
        {meta?.is_subagent && meta?.parent_session_id && (
          <button
            onClick={() => onOpenSession?.(meta.parent_session_id!, meta.spawn_tool_use_id ?? undefined)}
            disabled={!onOpenSession}
            className="mb-2 inline-flex items-center gap-1 text-xs text-teal hover:text-ink bg-teal-wash/40 rounded px-2 py-0.5 disabled:cursor-default"
            title="Open the session that spawned this subagent"
          >
            <span aria-hidden>↩</span>
            <span>Subagent of “{meta.parent_title || "parent session"}”</span>
          </button>
        )}
        <h1 className="heading-display text-xl mb-2 break-words">{meta?.title || meta?.subtask_title || firstPrompt || "Session"}</h1>
        <div className="flex items-center gap-4 text-xs text-slate flex-wrap">
          {meta?.git_branch && <span className="bg-panel px-1.5 py-0.5 rounded">{meta.git_branch}</span>}
          {data && <span>{messages.length} messages</span>}
          {meta && meta.subagents.length > 0 && (
            <span className="text-teal">{meta.subagents.length} subagent{meta.subagents.length !== 1 ? "s" : ""}</span>
          )}
        </div>
      </div>

      {meta && meta.subagents.length > 0 && onOpenSession && (
        <SubagentIndex
          subagents={meta.subagents}
          onOpen={onOpenSession}
          focusToolUseId={data && !focusInTranscript ? focusActive : undefined}
        />
      )}

      {loading && <p className="text-sm text-slate">Loading…</p>}
      {error && <p className="text-sm text-red-700">Failed to load: {error}</p>}
      {data && meta && (
        <MessageList
          messages={messages}
          subagentMap={subagentMap}
          sessionId={id}
          onOpenSubagent={onOpenSession}
          focusToolUseId={focusInTranscript ? focusActive : undefined}
          showThinking={showThinking}
          showTools={showTools}
        />
      )}
    </div>
  );
}
