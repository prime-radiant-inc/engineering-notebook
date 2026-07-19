import { useCallback, useEffect, useState } from "react";
import { getGroups, getGroup, getUngrouped, importDesktopGroups, type GroupRow, type GroupSessionRow } from "../api";
import { ThreePanel } from "../components/AppShell";
import { SessionView } from "../components/SessionView";

type Selection = { kind: "group"; id: number; name: string } | { kind: "ungrouped" } | null;

export default function Groups() {
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [desktopRunning, setDesktopRunning] = useState(false);
  const [selection, setSelection] = useState<Selection>(null);
  const [sessions, setSessions] = useState<GroupSessionRow[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [ungroupedTotal, setUngroupedTotal] = useState(0);
  const [banner, setBanner] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const refresh = useCallback(() => {
    getGroups().then((r) => { setGroups(r.groups); setDesktopRunning(r.desktopRunning); }).catch(() => {});
    getUngrouped().then((r) => setUngroupedTotal(r.total)).catch(() => {});
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    setSessionId(null);
    if (!selection) { setSessions([]); return; }
    if (selection.kind === "ungrouped") getUngrouped().then((r) => setSessions(r.sessions)).catch(() => setSessions([]));
    else getGroup(selection.id).then((r) => setSessions(r.sessions)).catch(() => setSessions([]));
  }, [selection]);

  async function sync() {
    setSyncing(true);
    setBanner(null);
    try {
      const r = await importDesktopGroups();
      if (r.error) setBanner(`Import failed: ${r.error}`);
      else if (!r.imported) setBanner(r.message || "No Claude Desktop groups found.");
      else {
        const s = r.summary!;
        setBanner(`Imported: +${s.groupsAdded} groups, ${s.sessionsAssigned} sessions assigned` +
          (s.skippedNoSession ? `, ${s.skippedNoSession} not-ingested` : "") + ".");
      }
      refresh();
    } catch (e: any) {
      setBanner(`Import failed: ${String(e.message ?? e)}`);
    } finally {
      setSyncing(false);
    }
  }

  const index = (
    <div className="py-2">
      <div className="px-3 py-2">
        <button onClick={sync} disabled={syncing}
          className="w-full text-xs px-2 py-1.5 rounded bg-teal-wash text-teal hover:text-ink disabled:opacity-50">
          {syncing ? "Syncing…" : "Sync from Claude Desktop"}
        </button>
        {desktopRunning && <div className="text-[10px] text-slate/70 mt-1">Claude Desktop is open — sync reads a snapshot.</div>}
        {banner && <div className="text-[11px] text-slate mt-1">{banner}</div>}
      </div>
      {groups.map((g) => (
        <button key={g.id} onClick={() => setSelection({ kind: "group", id: g.id, name: g.name })}
          className={`block w-full text-left px-4 py-2 border-b border-edge/60 ${selection?.kind === "group" && selection.id === g.id ? "bg-panel" : "hover:bg-surface"}`}>
          <div className="text-sm text-ink flex justify-between"><span>{g.name}</span><span className="text-slate/70 text-xs">{g.sessionCount}</span></div>
          {g.lastActivityAt && <div className="text-[11px] text-slate/70">{g.lastActivityAt.slice(0, 10)}</div>}
        </button>
      ))}
      <button onClick={() => setSelection({ kind: "ungrouped" })}
        className={`block w-full text-left px-4 py-2 border-t border-edge ${selection?.kind === "ungrouped" ? "bg-panel" : "hover:bg-surface"}`}>
        <div className="text-sm text-slate flex justify-between"><span>Ungrouped</span><span className="text-slate/70 text-xs">{ungroupedTotal}</span></div>
      </button>
    </div>
  );

  const entriesPanel = (
    <div className="p-4">
      {!selection && <div className="text-xs text-slate">Select a group, or Ungrouped.</div>}
      {selection && sessions.length === 0 && <div className="text-xs text-slate">No sessions.</div>}
      {sessions.map((s) => (
        <button key={s.id} onClick={() => setSessionId(s.id)}
          className={`block w-full text-left px-3 py-2 border-b border-edge/60 rounded ${s.id === sessionId ? "bg-panel" : "hover:bg-surface"}`}>
          <div className="text-sm text-ink">{s.display_name || s.project_id}</div>
          <div className="text-[11px] text-slate/70">{s.started_at.slice(0, 10)} · {s.message_count} messages · {s.project_id}</div>
        </button>
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
