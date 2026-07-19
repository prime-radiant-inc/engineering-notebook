import { useEffect, useMemo, useState } from "react";
import { getSession, getTranscript, type SessionMeta, type Transcript as TranscriptData } from "../api";
import { MessageList } from "../session/MessageList";
import { toParsedMessages, toSubagentMap } from "../session/adapt";

// Panel-3 session viewer — a faithful port of claude-session-viewer's display.
export function SessionView({ id }: { id: string }) {
  const [meta, setMeta] = useState<SessionMeta | null>(null);
  const [data, setData] = useState<TranscriptData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showThinking, setShowThinking] = useState(false);
  const [showTools, setShowTools] = useState(false);

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

  const toggleCls = (active: boolean) =>
    `px-1.5 py-0.5 rounded text-xs transition-colors ${active ? "bg-panel text-slate hover:text-ink" : "bg-teal-wash text-teal hover:text-ink"}`;

  return (
    <div className="max-w-3xl">
      <div className="flex items-center gap-2 mb-4 flex-wrap sticky top-0 bg-white/90 backdrop-blur py-1 z-10">
        {meta && (
          <span className="text-xs text-slate/70">
            {meta.message_count} messages
            {meta.subagents.length > 0 && ` · ${meta.subagents.length} subagent${meta.subagents.length === 1 ? "" : "s"}`}
          </span>
        )}
        <div className="flex gap-2 ml-auto">
          <button className={toggleCls(showThinking)} onClick={() => setShowThinking((v) => !v)}>
            {showThinking ? "Hide thinking" : "Show thinking"}
          </button>
          <button className={toggleCls(showTools)} onClick={() => setShowTools((v) => !v)}>
            {showTools ? "Hide tools" : "Show tools"}
          </button>
        </div>
      </div>

      {loading && <p className="text-sm text-slate">Loading…</p>}
      {error && <p className="text-sm text-red-700">Failed to load: {error}</p>}
      {data && meta && (
        <MessageList
          messages={messages}
          subagentMap={subagentMap}
          sessionId={id}
          showThinking={showThinking}
          showTools={showTools}
        />
      )}
    </div>
  );
}
