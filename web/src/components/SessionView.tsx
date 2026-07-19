import { useEffect, useMemo, useState } from "react";
import { getSession, getTranscript, type SessionMeta, type Transcript as TranscriptData } from "../api";
import { MessageList } from "../session/MessageList";
import { toParsedMessages, toSubagentMap, extractTitle } from "../session/adapt";

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
  const firstPrompt = useMemo(() => extractTitle(messages), [messages]);

  const toggleCls = (active: boolean) =>
    `px-1.5 py-0.5 rounded transition-colors ${active ? "bg-panel text-slate hover:text-ink" : "bg-teal-wash text-teal hover:text-ink"}`;

  return (
    <div className="max-w-4xl">
      <div className="mb-6">
        <h1 className="heading-display text-xl mb-2 break-words">{firstPrompt || "Session"}</h1>
        <div className="flex items-center gap-4 text-xs text-slate flex-wrap">
          {meta?.git_branch && <span className="bg-panel px-1.5 py-0.5 rounded">{meta.git_branch}</span>}
          {data && <span>{messages.length} messages</span>}
          {meta && meta.subagents.length > 0 && (
            <span className="text-teal">{meta.subagents.length} subagent{meta.subagents.length !== 1 ? "s" : ""}</span>
          )}
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
