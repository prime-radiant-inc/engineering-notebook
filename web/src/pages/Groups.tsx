import { useCallback, useEffect, useState } from "react";
import { getGroups, getGroup, getUngrouped, importDesktopGroups, assignSessionToGroup, type GroupRow, type GroupSessionRow } from "../api";
import { ThreePanel } from "../components/AppShell";
import { SessionView } from "../components/SessionView";

type Selection = { kind: "group"; id: number; name: string } | { kind: "ungrouped" } | null;

export default function Groups() {
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [desktopRunning, setDesktopRunning] = useState(false);
  const [selection, setSelection] = useState<Selection>(null);
  const [sessions, setSessions] = useState<GroupSessionRow[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [focusTuid, setFocusTuid] = useState<string | undefined>(undefined);
  const openSession = (id: string, tuid?: string) => { setSessionId(id); setFocusTuid(tuid); };
  const [ungroupedTotal, setUngroupedTotal] = useState(0);
  const [banner, setBanner] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  // Which panel-1 row a dragged session is currently hovering (drop target cue).
  const [dropTarget, setDropTarget] = useState<number | "ungrouped" | null>(null);

  const refresh = useCallback(() => {
    getGroups().then((r) => { setGroups(r.groups); setDesktopRunning(r.desktopRunning); }).catch(() => {});
    getUngrouped().then((r) => setUngroupedTotal(r.total)).catch(() => {});
  }, []);

  const loadSessions = useCallback(() => {
    if (!selection) { setSessions([]); return; }
    if (selection.kind === "ungrouped") getUngrouped().then((r) => setSessions(r.sessions)).catch(() => setSessions([]));
    else getGroup(selection.id).then((r) => setSessions(r.sessions)).catch(() => setSessions([]));
  }, [selection]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { setSessionId(null); loadSessions(); }, [selection, loadSessions]);

  // Drop a dragged session onto a group (assign) or Ungrouped (unassign).
  async function assignTo(sessionId: string, groupId: number | null, label: string) {
    try {
      await assignSessionToGroup(sessionId, groupId);
      setBanner(groupId === null ? "Removed from group." : `Assigned to ${label}.`);
      refresh();
      loadSessions();
    } catch {
      setBanner("Assign failed.");
    }
  }

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
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDropTarget(g.id); }}
          onDragLeave={() => setDropTarget((t) => (t === g.id ? null : t))}
          onDrop={(e) => { e.preventDefault(); const sid = e.dataTransfer.getData("text/session-id"); setDropTarget(null); if (sid) assignTo(sid, g.id, g.name); }}
          className={`block w-full text-left px-4 py-2 border-b border-edge/60 ${dropTarget === g.id ? "ring-2 ring-inset ring-teal bg-teal-wash/40" : selection?.kind === "group" && selection.id === g.id ? "bg-panel" : "hover:bg-surface"}`}>
          <div className="text-sm text-ink flex justify-between"><span>{g.name}</span><span className="text-slate/70 text-xs">{g.sessionCount}</span></div>
          {g.lastActivityAt && <div className="text-[11px] text-slate/70">{g.lastActivityAt.slice(0, 10)}</div>}
        </button>
      ))}
      <button onClick={() => setSelection({ kind: "ungrouped" })}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDropTarget("ungrouped"); }}
        onDragLeave={() => setDropTarget((t) => (t === "ungrouped" ? null : t))}
        onDrop={(e) => { e.preventDefault(); const sid = e.dataTransfer.getData("text/session-id"); setDropTarget(null); if (sid) assignTo(sid, null, "Ungrouped"); }}
        className={`block w-full text-left px-4 py-2 border-t border-edge ${dropTarget === "ungrouped" ? "ring-2 ring-inset ring-teal bg-teal-wash/40" : selection?.kind === "ungrouped" ? "bg-panel" : "hover:bg-surface"}`}>
        <div className="text-sm text-slate flex justify-between"><span>Ungrouped</span><span className="text-slate/70 text-xs">{ungroupedTotal}</span></div>
      </button>
    </div>
  );

  const entriesPanel = (
    <div className="p-4">
      {!selection && <div className="text-xs text-slate">Select a group, or Ungrouped.</div>}
      {selection && sessions.length === 0 && <div className="text-xs text-slate">No sessions.</div>}
      {sessions.map((s) => {
        // Reveal a session's subagents only once it (or one of its subagents) is selected.
        const expanded = s.id === sessionId || (s.subagents?.some((sub) => sub.id === sessionId) ?? false);
        return (
        <div key={s.id}>
          <button onClick={() => openSession(s.id)}
            draggable
            onDragStart={(e) => { e.dataTransfer.setData("text/session-id", s.id); e.dataTransfer.effectAllowed = "move"; }}
            title="Drag onto a group to assign"
            className={`block w-full text-left px-3 py-2 border-b border-edge/60 rounded cursor-grab active:cursor-grabbing ${s.id === sessionId ? "bg-panel" : "hover:bg-surface"}`}>
            <div className="text-sm text-ink">{s.title || s.display_name || s.project_id}</div>
            <div className="text-[11px] text-slate/70">{s.started_at.slice(0, 10)} · {s.message_count} messages · {s.project_id}</div>
          </button>
          {expanded && (s.subagents?.length ?? 0) > 0 && (
            <div className="ml-3 my-1 flex flex-col gap-0.5 border-l border-edge/50 pl-2">
              {s.subagents!.map((sub) => (
                <button key={sub.id} onClick={() => openSession(sub.id)}
                  title={sub.description || sub.agentType || "subtask"}
                  className={`text-left text-[11px] px-2 py-0.5 rounded flex items-center gap-1 ${sub.id === sessionId ? "text-teal font-medium" : "text-slate/60 hover:text-slate"}`}>
                  <span aria-hidden>🤖</span>
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

  const detail = (
    <div className="p-6">
      {sessionId ? <SessionView id={sessionId} onOpenSession={openSession} focusToolUseId={focusTuid} /> : <div className="text-sm text-slate">Select a session to view its transcript.</div>}
    </div>
  );

  return <ThreePanel index={index} entries={entriesPanel} detail={detail} />;
}
