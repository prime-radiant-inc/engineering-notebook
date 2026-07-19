import { useEffect, useState } from "react";
import { getProjects, getProjectEntries, type ProjectRow, type JournalEntry } from "../api";
import { ThreePanel } from "../components/AppShell";
import { SessionView } from "../components/SessionView";

export default function Projects() {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getProjects()
      .then((r) => { setProjects(r.projects); if (r.projects[0]) setProjectId(r.projects[0].id); })
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  useEffect(() => {
    if (!projectId) { setEntries([]); return; }
    setSessionId(null);
    getProjectEntries(projectId).then((r) => setEntries(r.entries)).catch(() => setEntries([]));
  }, [projectId]);

  const index = (
    <div className="py-2">
      {error && <div className="px-4 py-3 text-xs text-red-700">Failed to load: {error}</div>}
      {projects.map((p) => (
        <button key={p.id} onClick={() => setProjectId(p.id)}
          className={`block w-full text-left px-4 py-2 border-b border-edge/60 ${p.id === projectId ? "bg-panel" : "hover:bg-surface"}`}>
          <div className="text-sm text-ink">{p.display_name || p.id}</div>
          <div className="text-[11px] text-slate/70">{p.session_count} sessions{p.last_session_at ? ` · ${p.last_session_at.slice(0, 10)}` : ""}</div>
        </button>
      ))}
    </div>
  );

  const entriesPanel = (
    <div className="p-4">
      {entries.length === 0 && <div className="text-xs text-slate">No summarized entries for this project.</div>}
      {entries.map((e) => (
        <div key={e.id} className="border border-edge rounded-lg p-3 mb-3">
          <div className="text-[11px] text-slate/70">{e.date}</div>
          {e.headline && <div className="font-semibold text-ink mt-0.5">{e.headline}</div>}
          <div className="text-sm text-slate mt-1 whitespace-pre-wrap">{e.summary}</div>
          {e.topics.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {e.topics.map((t) => <span key={t} className="text-[11px] bg-panel text-slate rounded px-1.5 py-0.5">{t}</span>)}
            </div>
          )}
          {e.sessions.length > 0 && (
            <div className="mt-2 flex flex-col gap-1">
              {e.sessions.map((s, i) => (
                <button key={s.id} onClick={() => setSessionId(s.id)}
                  className={`text-left text-xs px-2 py-1 rounded border ${s.id === sessionId ? "bg-teal text-white border-teal" : "border-edge text-slate hover:border-teal"}`}>
                  {s.title || `Session ${i + 1}`}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );

  const detail = (
    <div className="p-6">
      {sessionId ? <SessionView id={sessionId} /> : <div className="text-sm text-slate">Select a session to view its transcript.</div>}
    </div>
  );

  return <ThreePanel index={index} entries={entriesPanel} detail={detail} />;
}
