import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getSession, getTranscript, type SessionMeta, type Transcript as TranscriptData } from "../api";
import { Transcript } from "../components/Transcript";

export default function SessionDetail() {
  const { id = "" } = useParams();
  const [meta, setMeta] = useState<SessionMeta | null>(null);
  const [data, setData] = useState<TranscriptData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showThinking, setShowThinking] = useState(false);
  const [showTools, setShowTools] = useState(false);

  useEffect(() => {
    setLoading(true);
    Promise.all([getSession(id), getTranscript(id)])
      .then(([m, t]) => { setMeta(m); setData(t); })
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setLoading(false));
  }, [id]);

  const btn = (active: boolean) =>
    `px-2 py-0.5 rounded text-xs border ${active ? "bg-accent text-white border-accent" : "border-stone-300 text-stone-600 hover:border-accent"}`;

  return (
    <div className="max-w-3xl mx-auto p-6">
      <Link to="/" className="text-sm text-stone-500 hover:text-accent">&larr; Sessions</Link>

      <div className="flex items-center gap-3 mt-2 mb-4 flex-wrap">
        <h1 className="text-lg font-semibold text-stone-900">
          {meta?.project_id || "Session"}
        </h1>
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
