import { Database } from "bun:sqlite";
import { escapeHtml, projectColor } from "./helpers";
import { excludeWhere } from "./projects";

type CalendarEntry = {
  date: string;
  project_id: string;
  display_name: string;
  headline: string;
  entry_id: number | null;
};

/** Get Monday of the week containing the given date string. */
export function weekMonday(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  const day = d.getUTCDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day; // shift so Monday=0
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

/** Get first day of the month containing the given date string. */
function monthStart(dateStr: string): string {
  return dateStr.slice(0, 7) + "-01";
}

/** Get number of days in the month of the given YYYY-MM-DD. */
function daysInMonth(dateStr: string): number {
  const [y, m] = dateStr.split("-").map(Number) as [number, number];
  return new Date(y, m, 0).getDate();
}

/** Add N days to a YYYY-MM-DD string. */
function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Format YYYY-MM-DD to short day label like "Mon 17". */
function dayLabel(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  const day = d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  return `${day} ${d.getUTCDate()}`;
}

/** Format a date range for the header. */
function periodLabel(startDate: string, endDate: string, mode: "week" | "month"): string {
  const s = new Date(startDate + "T12:00:00Z");
  const e = new Date(endDate + "T12:00:00Z");
  if (mode === "week") {
    const sMonth = s.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
    const eMonth = e.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
    const year = s.getUTCFullYear();
    if (sMonth === eMonth) {
      return `${sMonth} ${s.getUTCDate()}\u2013${e.getUTCDate()}, ${year}`;
    }
    return `${sMonth} ${s.getUTCDate()} \u2013 ${eMonth} ${e.getUTCDate()}, ${year}`;
  }
  return s.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** Query journal entries + unsummarized session activity for a date range. */
function queryActivity(
  db: Database,
  startDate: string,
  endDate: string,
  exclude: string[]
): CalendarEntry[] {
  const ex = excludeWhere(exclude);

  // Summarized entries
  const entries = db.query(`
    SELECT je.date, je.project_id, p.display_name, je.headline, je.id as entry_id
    FROM journal_entries je
    JOIN projects p ON je.project_id = p.id
    WHERE je.date BETWEEN ? AND ?
      AND je.headline != ''
      ${ex.sql.replace(/\bid\b/g, "p.id")}
    ORDER BY je.date, p.display_name
  `).all(startDate, endDate, ...ex.params) as {
    date: string; project_id: string; display_name: string; headline: string; entry_id: number;
  }[];

  // Build a set of (date, project_id) that already have entries
  const covered = new Set(entries.map(e => `${e.date}|${e.project_id}`));

  // Unsummarized activity from sessions
  const sessions = db.query(`
    SELECT date(s.started_at) as date, s.project_id, p.display_name
    FROM sessions s
    JOIN projects p ON s.project_id = p.id
    WHERE date(s.started_at) BETWEEN ? AND ?${ex.sql.replace(/\bid\b/g, "p.id")}
    GROUP BY date(s.started_at), s.project_id
  `).all(startDate, endDate, ...ex.params) as {
    date: string; project_id: string; display_name: string;
  }[];

  const result: CalendarEntry[] = entries.map(e => ({
    date: e.date,
    project_id: e.project_id,
    display_name: e.display_name,
    headline: e.headline,
    entry_id: e.entry_id,
  }));

  for (const s of sessions) {
    if (!covered.has(`${s.date}|${s.project_id}`)) {
      result.push({
        date: s.date,
        project_id: s.project_id,
        display_name: s.display_name,
        headline: "",
        entry_id: null,
      });
    }
  }

  return result;
}

/** Render the Gantt grid HTML for a set of days and entries. */
function renderGanttGrid(
  days: string[],
  entries: CalendarEntry[],
  today: string
): string {
  // Collect unique projects in display order (most active first)
  const projectActivity = new Map<string, { name: string; count: number }>();
  for (const e of entries) {
    const existing = projectActivity.get(e.project_id);
    if (existing) {
      existing.count++;
    } else {
      projectActivity.set(e.project_id, { name: e.display_name, count: 1 });
    }
  }
  const projects = [...projectActivity.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([id, { name }]) => ({ id, name }));

  if (projects.length === 0) {
    return '<div class="empty-state">No activity in this period.</div>';
  }

  // Build lookup: (date, project_id) -> entry
  const lookup = new Map<string, CalendarEntry>();
  for (const e of entries) {
    lookup.set(`${e.date}|${e.project_id}`, e);
  }

  const cols = days.length;
  let html = `<div class="gantt-grid" style="grid-template-columns: 140px repeat(${cols}, 1fr);">`;

  // Header row
  html += `<div class="gantt-corner"></div>`;
  for (const day of days) {
    const isToday = day === today;
    html += `<a class="gantt-header${isToday ? " gantt-header-today" : ""}" href="/?date=${day}">${dayLabel(day)}</a>`;
  }

  // Build per-project active day sets for consecutive-run detection
  const activeDays = new Map<string, Set<string>>();
  for (const project of projects) {
    const active = new Set<string>();
    for (const day of days) {
      if (lookup.has(`${day}|${project.id}`)) active.add(day);
    }
    activeDays.set(project.id, active);
  }

  // Project rows
  for (const project of projects) {
    const color = projectColor(project.id);
    const active = activeDays.get(project.id)!;
    html += `<a class="gantt-label" href="/projects/${encodeURIComponent(project.id)}"><span class="gantt-label-dot" style="background:${color}"></span>${escapeHtml(project.name || project.id)}</a>`;
    for (let i = 0; i < days.length; i++) {
      const day = days[i]!;
      const entry = lookup.get(`${day}|${project.id}`);
      html += `<div class="gantt-cell">`;
      if (entry) {
        const prevActive = i > 0 && active.has(days[i - 1]!);
        const nextActive = i < days.length - 1 && active.has(days[i + 1]!);
        let posClass: string;
        if (prevActive && nextActive) posClass = "gantt-bar-mid";
        else if (prevActive) posClass = "gantt-bar-end";
        else if (nextActive) posClass = "gantt-bar-start";
        else posClass = "gantt-bar-single";

        const href = entry.entry_id
          ? `/projects/${encodeURIComponent(project.id)}/${entry.entry_id}`
          : `/projects/${encodeURIComponent(project.id)}`;
        const title = entry.headline ? escapeHtml(entry.headline) : escapeHtml(project.name || project.id);
        html += `<a class="gantt-bar ${posClass}" href="${href}" title="${title}" style="background:${color}"></a>`;
      }
      html += `</div>`;
    }
  }

  html += `</div>`;
  return html;
}

/** Render the full calendar page body (week or month mode). */
export function renderCalendarPage(
  db: Database,
  mode: "week" | "month",
  refDate: string,
  exclude: string[]
): string {
  const today = new Date().toISOString().slice(0, 10);

  let startDate: string;
  let endDate: string;
  let days: string[];

  if (mode === "week") {
    startDate = weekMonday(refDate);
    endDate = addDays(startDate, 6);
    days = Array.from({ length: 7 }, (_, i) => addDays(startDate, i));
  } else {
    startDate = monthStart(refDate);
    const numDays = daysInMonth(startDate);
    endDate = addDays(startDate, numDays - 1);
    days = Array.from({ length: numDays }, (_, i) => addDays(startDate, i));
  }

  const entries = queryActivity(db, startDate, endDate, exclude);

  // Navigation
  const prevRef = mode === "week" ? addDays(startDate, -7) : addDays(startDate, -1).slice(0, 7) + "-01";
  const nextRef = mode === "week" ? addDays(startDate, 7) : addDays(endDate, 1);
  const period = periodLabel(startDate, endDate, mode);

  const hx = (url: string) => `href="${url}" hx-get="${url}" hx-target="#calendar-page" hx-swap="innerHTML" hx-push-url="true"`;

  let html = `<div class="calendar-toolbar">`;
  html += `<div class="calendar-arrows">`;
  html += `<a ${hx(`/calendar?mode=${mode}&ref=${prevRef}`)} title="Previous">&lsaquo;</a>`;
  html += `<a ${hx(`/calendar?mode=${mode}&ref=${nextRef}`)} title="Next">&rsaquo;</a>`;
  html += `</div>`;
  html += `<div class="calendar-period">${escapeHtml(period)}</div>`;
  html += `<div class="calendar-mode-toggle">`;
  html += `<a ${hx(`/calendar?mode=week&ref=${startDate}`)} class="${mode === "week" ? "active" : ""}">Week</a>`;
  html += `<a ${hx(`/calendar?mode=month&ref=${startDate}`)} class="${mode === "month" ? "active" : ""}">Month</a>`;
  html += `</div>`;
  html += `</div>`;

  html += `<div class="gantt-wrap">`;
  html += renderGanttGrid(days, entries, today);
  html += `</div>`;

  return html;
}

// ─────────────────────────────────────────────
// iCal Feed
// ─────────────────────────────────────────────

/** Fold a line to 75-octet max per RFC 5545. */
function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [];
  parts.push(line.slice(0, 75));
  let pos = 75;
  while (pos < line.length) {
    parts.push(" " + line.slice(pos, pos + 74));
    pos += 74;
  }
  return parts.join("\r\n");
}

/** Escape text for iCal property values. */
function icalEscape(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/** Format YYYY-MM-DD to YYYYMMDD for iCal DATE values. */
function icalDate(dateStr: string): string {
  return dateStr.replace(/-/g, "");
}

/** Render a complete iCal feed from journal entries. */
export function renderIcalFeed(db: Database, exclude: string[]): string {
  const ex = excludeWhere(exclude);

  const entries = db.query(`
    SELECT je.id, je.date, je.headline, je.summary, je.generated_at, p.display_name
    FROM journal_entries je
    JOIN projects p ON je.project_id = p.id
    WHERE je.headline != ''${ex.sql.replace(/\bid\b/g, "p.id")}
    ORDER BY je.date DESC
  `).all(...ex.params) as {
    id: number; date: string; headline: string; summary: string;
    generated_at: string; display_name: string;
  }[];

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Engineering Notebook//EN",
    "X-WR-CALNAME:Engineering Notebook",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];

  for (const entry of entries) {
    const startDate = icalDate(entry.date);
    const endDate = icalDate(addDays(entry.date, 1));
    const summary = entry.headline
      ? `[${entry.display_name}] ${entry.headline}`
      : `[${entry.display_name}] Activity`;
    const dtstamp = entry.generated_at
      ? entry.generated_at.replace(/[-:]/g, "").replace(/\.\d+/, "").slice(0, 15) + "Z"
      : startDate + "T120000Z";

    lines.push("BEGIN:VEVENT");
    lines.push(foldLine(`UID:journal-entry-${entry.id}@engineering-notebook`));
    lines.push(`DTSTART;VALUE=DATE:${startDate}`);
    lines.push(`DTEND;VALUE=DATE:${endDate}`);
    lines.push(foldLine(`SUMMARY:${icalEscape(summary)}`));
    if (entry.summary) {
      lines.push(foldLine(`DESCRIPTION:${icalEscape(entry.summary)}`));
    }
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}
