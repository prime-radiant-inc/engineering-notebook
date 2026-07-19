import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getSessions, type SessionListRow } from "../api";

function fmtDate(iso: string): string {
  return iso ? iso.slice(0, 10) : "";
}

export default function SessionList() {
  const [rows, setRows] = useState<SessionListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getSessions({ limit: 100 })
      .then((r) => { setRows(r.sessions); setTotal(r.total); })
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="max-w-3xl mx-auto p-6">
      <h1 className="text-xl font-semibold text-accent mb-1">Sessions</h1>
      <p className="text-xs text-stone-500 mb-4">
        {loading ? "Loading…" : `${rows.length} of ${total}`}
      </p>

      {error && <div className="text-sm text-red-700 mb-4">Failed to load: {error}</div>}

      <ul className="divide-y divide-stone-200">
        {rows.map((s) => (
          <li key={s.id} className="py-2">
            <Link to={`/s/${s.id}`} className="text-stone-900 hover:text-accent">
              {s.display_name || s.project_id}
            </Link>
            <div className="text-xs text-stone-500">
              {fmtDate(s.started_at)} · {s.message_count} messages · {s.project_id}
            </div>
          </li>
        ))}
      </ul>

      {!loading && rows.length === 0 && !error && (
        <div className="text-sm text-stone-400">No sessions found.</div>
      )}
    </div>
  );
}
