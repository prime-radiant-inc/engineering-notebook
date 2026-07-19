import { useEffect, useState } from "react";
import { getSession, getTranscript, type SessionMeta, type Transcript as TranscriptData } from "../api";
import { Transcript } from "./Transcript";

// The session viewer core (toggles + transcript), usable inside a panel.
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
    Promise.all([getSession(id), getTranscript(id)])
      .then(([m, t]) => { setMeta(m); setData(t); })
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setLoading(false));
  }, [id]);

  const btn = (active: boolean) =>
    `px-2 py-0.5 rounded text-xs border ${active ? "bg-accent text-white border-accent" : "border-stone-300 text-stone-600 hover:border-accent"}`;

  return (
    <div>
      <div className="flex items-center gap-2 mb-4 flex-wrap sticky top-0 bg-white/90 backdrop-blur py-1">
        {meta && (
          <span className="text-xs text-stone-400">
            {meta.message_count} messages
            {meta.subagents.length > 0 && ` · ${meta.subagents.length} subagent${meta.subagents.length === 1 ? "" : "s"}`}
          </span>
        )}
        <div className="flex gap-2 ml-auto">
          <button className={btn(showThinking)} onClick={() => setShowThinking((v) => !v)}>
            {showThinking ? "Hide thinking" : "Show thinking"}
          </button>
          <button className={btn(showTools)} onClick={() => setShowTools((v) => !v)}>
            {showTools ? "Hide tools" : "Show tools"}
          </button>
        </div>
      </div>

      {loading && <p className="text-sm text-stone-400">Loading…</p>}
      {error && <p className="text-sm text-red-700">Failed to load: {error}</p>}
      {data && meta && (
        <Transcript
          messages={data.messages}
          subagents={meta.subagents}
          sessionId={id}
          showThinking={showThinking}
          showTools={showTools}
        />
      )}
    </div>
  );
}
