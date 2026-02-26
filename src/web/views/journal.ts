import { Database } from "bun:sqlite";
import { escapeHtml, formatDateShort, formatDate, formatTimeAmPm, formatTime, groupByTimeBucket } from "./helpers";
import { inferAssistantDisplayName, inferUserDisplayName, renderConversation } from "./conversation";
import { renderSessionFooter } from "./session";

type JournalEntryRow = {
  id: number;
  date: string;
  project_id: string;
  display_name: string;
  headline: string;
  summary: string;
  topics: string;
  session_ids: string;
  open_questions: string;
};

type DateProjectsRow = {
  date: string;
  projects: string; // comma-separated project display names
};

/**
 * Panel 1: Date index with project names under each date.
 */
export function renderJournalDateIndex(db: Database, selectedDate?: string): string {
  const rows = db.query(`
    SELECT je.date, GROUP_CONCAT(DISTINCT p.display_name) as projects
    FROM journal_entries je
    JOIN projects p ON je.project_id = p.id
    GROUP BY je.date
    ORDER BY je.date DESC
  `).all() as DateProjectsRow[];

  if (rows.length === 0) {
    return '<div class="empty-state">No journal entries yet.<br>Run <code>notebook summarize</code> to generate them.</div>';
  }

  const dates = rows.map(r => r.date);
  const projectsByDate = new Map(rows.map(r => [r.date, r.projects]));
  const buckets = groupByTimeBucket(dates);

  let html = "";
  for (const [bucketName, bucketDates] of buckets) {
    html += `<div class="index-section-label">${escapeHtml(bucketName)}</div>`;
    for (const date of bucketDates) {
      const isSelected = date === selectedDate;
      const projects = projectsByDate.get(date) || "";
      html += `<a class="index-item${isSelected ? " selected" : ""}" href="/?date=${date}" hx-get="/api/journal/entries?date=${date}" hx-target="#panel-entries" hx-push-url="/?date=${date}">`;
      html += `<div class="index-item-title">${formatDateShort(date)}</div>`;
      const projectList = projects.split(",").map(p => escapeHtml(p.trim())).join("<br>");
      html += `<div class="index-item-sub">${projectList}</div>`;
      html += `</a>`;
    }
  }
  return html;
}

/**
 * Panel 2: Journal entries for a specific date.
 */
export function renderJournalEntries(db: Database, date: string, selectedEntryId?: number): string {
  const entries = db.query(`
    SELECT je.id, je.date, je.project_id, p.display_name, je.headline, je.summary, je.topics, je.session_ids, je.open_questions
    FROM journal_entries je
    JOIN projects p ON je.project_id = p.id
    WHERE je.date = ?
    ORDER BY p.display_name
  `).all(date) as JournalEntryRow[];

  let html = `<div class="page-title">${formatDate(date)}</div>`;

  if (entries.length === 0) {
    html += '<div class="empty-state">No entries for this date.</div>';
    return html;
  }

  for (const entry of entries) {
    const isSelected = entry.id === selectedEntryId;
    const sessionIds = JSON.parse(entry.session_ids || "[]") as string[];
    const topics: string[] = JSON.parse(entry.topics || "[]");

    // Compute time range from sessions
    const timeRange = getSessionTimeRange(db, sessionIds);

    html += `<a class="entry-card${isSelected ? " selected" : ""}" href="/?date=${date}&entry=${entry.id}" hx-get="/api/journal/conversation?entry_id=${entry.id}" hx-target="#panel-detail">`;
    html += `<div class="entry-label">${escapeHtml(entry.display_name)}</div>`;
    if (entry.headline) {
      html += `<div class="entry-headline">${escapeHtml(entry.headline)}</div>`;
    }
    html += `<div class="entry-summary">${escapeHtml(entry.summary)}</div>`;
    if (topics.length > 0) {
      html += `<div class="entry-tags">`;
      for (const t of topics) {
        html += `<span class="entry-tag">${escapeHtml(t)}</span>`;
      }
      html += `</div>`;
    }
    const openQuestions: string[] = JSON.parse(entry.open_questions || "[]");
    if (openQuestions.length > 0) {
      html += `<div class="entry-questions-label">Open questions</div>`;
      html += `<ul class="entry-questions">`;
      for (const q of openQuestions) {
        html += `<li>${escapeHtml(q)}</li>`;
      }
      html += `</ul>`;
    }
    html += `<div class="entry-stats">${sessionIds.length} session${sessionIds.length !== 1 ? "s" : ""}${timeRange ? ` · ${timeRange}` : ""}</div>`;
    html += `</a>`;
  }
  return html;
}

function getSessionTimeRange(db: Database, sessionIds: string[]): string {
  if (sessionIds.length === 0) return "";
  const placeholders = sessionIds.map(() => "?").join(",");
  const row = db.query(`
    SELECT MIN(started_at) as earliest, MAX(COALESCE(ended_at, started_at)) as latest
    FROM sessions WHERE id IN (${placeholders})
  `).get(...sessionIds) as { earliest: string; latest: string } | null;
  if (!row || !row.earliest) return "";
  const start = formatTimeAmPm(formatTime(row.earliest));
  const end = formatTimeAmPm(formatTime(row.latest));
  return start === end ? start : `${start} – ${end}`;
}

/**
 * Full page content: picks the selected or most recent date,
 * returns all three panel contents.
 */
export function renderJournalPage(db: Database, date?: string, entryId?: number): {
  panel1: string;
  panel2: string;
  panel3: string;
} {
  // If no date specified, use the most recent
  if (!date) {
    const row = db.query(`SELECT date FROM journal_entries ORDER BY date DESC LIMIT 1`).get() as { date: string } | null;
    date = row?.date;
  }

  const panel1 = renderJournalDateIndex(db, date);

  if (!date) {
    return { panel1, panel2: '<div class="empty-state">No journal entries yet.</div>', panel3: "" };
  }

  const panel2 = renderJournalEntries(db, date, entryId ?? undefined);

  let panel3 = '<div class="empty-state">Select an entry to view conversations.</div>';
  if (entryId) {
    panel3 = renderEntryConversations(db, entryId);
  }

  return { panel1, panel2, panel3 };
}

/**
 * Render conversations for a journal entry (for Panel 3).
 */
export function renderEntryConversations(db: Database, entryId: number, sessionIndex: number = 0): string {
  const entry = db.query(`SELECT session_ids FROM journal_entries WHERE id = ?`).get(entryId) as { session_ids: string } | null;
  if (!entry) return '<div class="empty-state">Entry not found.</div>';

  const sessionIds: string[] = JSON.parse(entry.session_ids || "[]");
  if (sessionIds.length === 0) return '<div class="empty-state">No sessions for this entry.</div>';

  const idx = Math.max(0, Math.min(sessionIndex, sessionIds.length - 1));
  const sessionId = sessionIds[idx]!;

  const convo = db.query(`
    SELECT c.conversation_markdown, s.project_path, s.source_path
    FROM conversations c
    JOIN sessions s ON s.id = c.session_id
    WHERE c.session_id = ?
  `).get(sessionId) as { conversation_markdown: string; project_path: string; source_path: string } | null;

  let html = `<button class="panel-dismiss" onclick="this.parentElement.innerHTML='<div class=\\'empty-state\\'>Select an entry to view conversations.</div>'">&times;</button>`;
  // Session navigator
  if (sessionIds.length > 1) {
    html += `<div class="conversation-nav">`;
    html += `Session ${idx + 1} of ${sessionIds.length}`;
    if (idx > 0) {
      html += ` · <a hx-get="/api/journal/conversation?entry_id=${entryId}&session_idx=${idx - 1}" hx-target="#panel-detail">&larr; Prev</a>`;
    }
    if (idx < sessionIds.length - 1) {
      html += ` · <a hx-get="/api/journal/conversation?entry_id=${entryId}&session_idx=${idx + 1}" hx-target="#panel-detail">Next &rarr;</a>`;
    }
    html += `</div>`;
  }

  if (convo) {
    html += renderConversation(
      convo.conversation_markdown,
      inferUserDisplayName(convo.project_path),
      inferAssistantDisplayName(convo.source_path)
    );
  } else {
    html += '<div class="empty-state">Conversation not available.</div>';
  }

  const sessionMeta = db.query(`SELECT project_path, source_path FROM sessions WHERE id = ?`).get(sessionId) as { project_path: string; source_path: string } | null;
  if (sessionMeta) {
    html += renderSessionFooter(sessionId, sessionMeta.project_path, sessionMeta.source_path);
  }

  return html;
}
