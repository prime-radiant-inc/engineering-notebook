import { useState } from "react";
import { getSubagent, type Transcript as TranscriptData } from "../api";
import { Transcript } from "./Transcript";

export function SubagentPanel({
  sessionId,
  agentId,
  description,
  agentType,
  showThinking,
  showTools,
}: {
  sessionId: string;
  agentId: string;
  description?: string;
  agentType?: string;
  showThinking: boolean;
  showTools: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<TranscriptData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function onToggle(e: React.SyntheticEvent<HTMLDetailsElement>) {
    const isOpen = e.currentTarget.open;
    setOpen(isOpen);
    if (isOpen && !data && !loading) {
      setLoading(true);
      getSubagent(sessionId, agentId)
        .then(setData)
        .catch((err) => setError(String(err.message ?? err)))
        .finally(() => setLoading(false));
    }
  }

  return (
    <details className="border-l-2 border-accent/40 pl-3 my-2" onToggle={onToggle} open={open}>
      <summary className="cursor-pointer list-none text-xs text-accent select-none">
        <span className="font-semibold">Subagent</span>
        {agentType && <span className="ml-1 text-stone-400">({agentType})</span>}
        {description && <span className="ml-2 text-stone-500">{description}</span>}
      </summary>
      <div className="mt-2">
        {loading && <p className="text-xs text-stone-400">Loading subagent…</p>}
        {error && <p className="text-xs text-red-700">Failed to load subagent: {error}</p>}
        {data && (
          <Transcript
            messages={data.messages}
            subagents={[]}
            sessionId={sessionId}
            showThinking={showThinking}
            showTools={showTools}
          />
        )}
      </div>
    </details>
  );
}
