import type { SessionRef } from "../api";

// Panel-2 session list: each real session, with its subagents nested and dimmed
// beneath it. Selecting either opens it in panel 3.
export function SessionRefList({
  sessions,
  selectedId,
  onSelect,
  variant,
}: {
  sessions: SessionRef[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  variant: "journal" | "projects";
}) {
  const sel =
    variant === "journal" ? "bg-accent text-white border-accent" : "bg-teal text-white border-teal";
  const unsel =
    variant === "journal"
      ? "border-stone-300 text-stone-600 hover:border-accent"
      : "border-edge text-slate hover:border-teal";

  return (
    <div className="mt-2 flex flex-col gap-1">
      {sessions.map((s, i) => {
        // Only reveal a session's subagents once that session (or one of its
        // own subagents) is the current selection.
        const expanded = s.id === selectedId || (s.subagents?.some((sub) => sub.id === selectedId) ?? false);
        return (
        <div key={s.id} className="flex flex-col gap-1">
          <button
            onClick={() => onSelect(s.id)}
            className={`text-left text-xs px-2 py-1 rounded border ${s.id === selectedId ? sel : unsel}`}
          >
            {s.title || `Session ${i + 1}`}
          </button>
          {expanded && (s.subagents?.length ?? 0) > 0 && (
            <div className="ml-3 flex flex-col gap-0.5 border-l border-edge/50 pl-2">
              {s.subagents.map((sub) => (
                <button
                  key={sub.id}
                  onClick={() => onSelect(sub.id)}
                  title={sub.description || sub.agentType || "subagent"}
                  className={`text-left text-[11px] px-2 py-0.5 rounded flex items-center gap-1 ${
                    sub.id === selectedId ? "text-teal font-medium" : "text-slate/60 hover:text-slate"
                  }`}
                >
                  <span aria-hidden>🤖</span>
                  {/* Label is the subtask title (description); agent type is not shown. */}
                  <span className="truncate">{sub.description || sub.agentType || "subtask"}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        );
      })}
    </div>
  );
}
