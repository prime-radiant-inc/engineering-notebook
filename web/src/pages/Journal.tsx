import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { getJournalDates, getJournalEntries, type JournalDate, type JournalEntry } from "../api";
import { ThreePanel } from "../components/AppShell";
import { SessionView } from "../components/SessionView";

function fmtDate(iso: string): string {
  return iso; // YYYY-MM-DD; kept simple
}

export default function Journal() {
  const [searchParams] = useSearchParams();
  const urlDate = searchParams.get("date");
  const [dates, setDates] = useState<JournalDate[]>([]);
  const [date, setDate] = useState<string | null>(null);
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [datesError, setDatesError] = useState<string | null>(null);
  const [loadingDates, setLoadingDates] = useState(true);

  useEffect(() => {
    getJournalDates()
      .then((d) => {
        setDates(d.dates);
        setDate(urlDate && d.dates.some((x) => x.date === urlDate) ? urlDate : d.dates[0]?.date ?? null);
      })
      .catch((e) => setDatesError(String(e.message ?? e)))
      .finally(() => setLoadingDates(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow a ?date= change coming from the Calendar.
  useEffect(() => {
    if (urlDate && dates.some((x) => x.date === urlDate)) setDate(urlDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlDate]);

  useEffect(() => {
    if (!date) { setEntries([]); return; }
    setSessionId(null);
    getJournalEntries(date).then((r) => setEntries(r.entries)).catch(() => setEntries([]));
  }, [date]);

  const index = (
    <div className="py-2">
      {loadingDates && <div className="px-4 py-3 text-xs text-stone-400">Loading…</div>}
      {datesError && <div className="px-4 py-3 text-xs text-red-700">Failed to load: {datesError}</div>}
      {!loadingDates && dates.length === 0 && !datesError && (
        <div className="px-4 py-3 text-xs text-stone-400">
          No journal entries yet. Run <code>engineering-notebook summarize --all</code>.
        </div>
      )}
      {dates.map((d) => (
        <button
          key={d.date}
          onClick={() => setDate(d.date)}
          className={`block w-full text-left px-4 py-2 border-b border-stone-100 ${d.date === date ? "bg-stone-100" : "hover:bg-stone-50"}`}
        >
          <div className="text-sm text-stone-800">{fmtDate(d.date)}</div>
          <div className="text-[11px] text-stone-400 leading-tight">{d.projects.join(" · ")}</div>
        </button>
      ))}
    </div>
  );

  const entriesPanel = (
    <div className="p-4">
      {date && <div className="font-serif font-bold text-stone-900 mb-3">{fmtDate(date)}</div>}
      {entries.length === 0 && <div className="text-xs text-stone-400">No entries for this date.</div>}
      {entries.map((e) => (
        <div key={e.id} className="border border-stone-200 rounded-lg p-3 mb-3">
          <div className="text-[11px] uppercase tracking-wide text-stone-400">{e.display_name}</div>
          {e.headline && <div className="font-semibold text-stone-900 mt-0.5">{e.headline}</div>}
          <div className="text-sm text-stone-600 mt-1 whitespace-pre-wrap">{e.summary}</div>
          {e.topics.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {e.topics.map((t) => (
                <span key={t} className="text-[11px] bg-stone-100 text-stone-500 rounded px-1.5 py-0.5">{t}</span>
              ))}
            </div>
          )}
          {e.open_questions.length > 0 && (
            <ul className="mt-2 text-xs text-stone-500 list-disc list-inside">
              {e.open_questions.map((q, i) => <li key={i}>{q}</li>)}
            </ul>
          )}
          {e.session_ids.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {e.session_ids.map((sid, i) => (
                <button
                  key={sid}
                  onClick={() => setSessionId(sid)}
                  className={`text-xs px-2 py-0.5 rounded border ${sid === sessionId ? "bg-accent text-white border-accent" : "border-stone-300 text-stone-600 hover:border-accent"}`}
                >
                  session {i + 1}
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
      {sessionId ? (
        <SessionView id={sessionId} />
      ) : (
        <div className="text-sm text-stone-400">Select a session to view its transcript.</div>
      )}
    </div>
  );

  return <ThreePanel index={index} entries={entriesPanel} detail={detail} />;
}
