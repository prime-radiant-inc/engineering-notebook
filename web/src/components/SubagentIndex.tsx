import { useEffect, useState } from "react";
import type { Subagent } from "../api";

// A compaction-proof list of every subagent in a session, sourced from the
// session's files (not the active transcript), so subagents remain reachable
// in panel 3 even when their spawn point was compacted off the active path.
// Collapsed by default to stay quiet on sessions you aren't drilling into.
export function SubagentIndex({
  subagents,
  onOpen,
  focusToolUseId,
}: {
  subagents: Subagent[];
  onOpen: (sessionId: string) => void;
  focusToolUseId?: string;
}) {
  const [open, setOpen] = useState(false);

  // When the backlink points at a subagent whose spawn was compacted off the
  // transcript, land the reader here: open the index and highlight that entry.
  const focusAgentId = focusToolUseId ? subagents.find((s) => s.toolUseId === focusToolUseId)?.agentId : undefined;
  useEffect(() => { if (focusAgentId) setOpen(true); }, [focusAgentId]);
  useEffect(() => {
    if (!focusAgentId || !open) return;
    const el = document.getElementById(`idx-${focusAgentId}`);
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusAgentId, open]);

  if (subagents.length === 0) return null;

  return (
    <div className="mb-4 border border-edge/60 rounded-lg bg-panel/20">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full text-left text-xs text-slate hover:text-ink px-3 py-1.5 flex items-center gap-1"
      >
        <span className={`inline-block transition-transform ${open ? "rotate-90" : ""}`}>&#9654;</span>
        <span className="font-medium">
          {subagents.length} subagent{subagents.length !== 1 ? "s" : ""}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-2 flex flex-col gap-0.5">
          {subagents.map((s) => (
            <button
              id={`idx-${s.agentId}`}
              key={s.agentId}
              onClick={() => onOpen(`agent-${s.agentId}`)}
              title={s.description || s.agentType || "subtask"}
              className={`text-left text-xs px-2 py-0.5 rounded flex items-center gap-1 hover:text-teal ${
                s.agentId === focusAgentId ? "text-teal font-medium ring-1 ring-teal" : "text-slate/70"
              }`}
            >
              <span aria-hidden>🤖</span>
              <span className="truncate">{s.description || s.agentType || "subtask"}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
