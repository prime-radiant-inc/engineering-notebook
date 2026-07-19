import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getCalendar, type CalendarDay } from "../api";

function ym(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function addMonths(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + delta, 1));
  return ym(d);
}
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function Calendar() {
  // default to the current month (UTC)
  const [month, setMonth] = useState<string>(() => ym(new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z")));
  const [days, setDays] = useState<CalendarDay[]>([]);

  useEffect(() => { getCalendar(month).then((r) => setDays(r.days)).catch(() => setDays([])); }, [month]);

  const byDate = useMemo(() => new Map(days.map((d) => [d.date, d])), [days]);

  const [y, m] = month.split("-").map(Number);
  const first = new Date(Date.UTC(y!, m! - 1, 1));
  const daysInMonth = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  const leading = first.getUTCDay();
  const cells: (string | null)[] = [];
  for (let i = 0; i < leading; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) cells.push(`${month}-${String(day).padStart(2, "0")}`);

  const monthLabel = first.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center gap-3 mb-4">
          <h1 className="heading-display text-xl">{monthLabel}</h1>
          <div className="ml-auto flex gap-2">
            <button className="text-sm text-slate hover:text-ink px-2" onClick={() => setMonth(addMonths(month, -1))}>&larr; Prev</button>
            <button className="text-sm text-slate hover:text-ink px-2" onClick={() => setMonth(addMonths(month, 1))}>Next &rarr;</button>
          </div>
        </div>

        <div className="grid grid-cols-7 gap-px bg-edge border border-edge rounded-lg overflow-hidden">
          {WEEKDAYS.map((w) => (
            <div key={w} className="bg-surface text-[11px] section-label text-center py-1.5">{w}</div>
          ))}
          {cells.map((date, i) => {
            if (!date) return <div key={`b${i}`} className="bg-white min-h-24" />;
            const d = byDate.get(date);
            const dayNum = Number(date.slice(-2));
            const cell = (
              <div className="bg-white min-h-24 p-1.5 flex flex-col">
                <div className="text-[11px] text-slate/70">{dayNum}</div>
                {d && (
                  <div className="mt-1">
                    <div className="text-xs font-medium text-teal">{d.entries} {d.entries === 1 ? "entry" : "entries"}</div>
                    <div className="text-[10px] text-slate/70 leading-tight line-clamp-3">{d.projects.join(" · ")}</div>
                  </div>
                )}
              </div>
            );
            return d ? (
              <Link key={date} to={`/?date=${date}`} className="hover:bg-surface">{cell}</Link>
            ) : (
              <div key={date}>{cell}</div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
