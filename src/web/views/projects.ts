import { Database } from "bun:sqlite";
import { escapeHtml, formatDateShort, groupByTimeBucket } from "./helpers";
import { renderEntryConversations } from "./journal";
import { groupSessionsByDateAndProject } from "../../summarize";

type ProjectRow = {
  id: string;
  display_name: string;
  last_session_at: string | null;
};

export type ProjectEntryRow = {
  id: number;
  date: string;
  headline: string;
  summary: string;
  topics: string;
  session_ids: string;
  open_questions: string;
};

/**
 * Build a WHERE clause fragment that excludes projects matching glob patterns.
 * Returns empty string if no patterns, otherwise " AND NOT id GLOB ? AND NOT ...".
 */
export function excludeWhere(exclude: string[]): { sql: string; params: string[] } {
  if (exclude.length === 0) return { sql: "", params: [] };
  const clauses = exclude.map(() => "id GLOB ?");
  return {
    sql: " AND NOT (" + clauses.join(" OR ") + ")",
    params: exclude,
  };
}

/**
 * Panel 1: Project index sorted by recency.
 */
export function renderProjectIndex(db: Database, selectedProject?: string, exclude: string[] = []): string {
  const ex = excludeWhere(exclude);
  const projects = db.query(`
    SELECT id, display_name, last_session_at
    FROM projects
    WHERE 1=1${ex.sql}
    ORDER BY last_session_at DESC
  `).all(...ex.params) as ProjectRow[];

  if (projects.length === 0) {
    return '<div class="empty-state">No projects yet.</div>';
  }

  let html = "";
  for (const p of projects) {
    const isSelected = p.id === selectedProject;
    const lastActive = p.last_session_at ? formatDateShort(p.last_session_at.slice(0, 10)) : "No sessions";
    html += `<a class="index-item${isSelected ? " selected" : ""}" href="/projects/${encodeURIComponent(p.id)}" hx-get="/api/projects/timeline?project=${encodeURIComponent(p.id)}" hx-target="#panel-entries" hx-push-url="/projects/${encodeURIComponent(p.id)}">`;
    html += `<div class="index-item-title">${escapeHtml(p.display_name || p.id)}</div>`;
    html += `<div class="index-item-sub">Last active ${escapeHtml(lastActive)}</div>`;
    html += `</a>`;
  }
  return html;
}

/** Render a single entry card */
export function renderEntryCard(entry: ProjectEntryRow, projectId: string, isSelected: boolean): string {
  const sessionIds: string[] = JSON.parse(entry.session_ids || "[]");
  const topics: string[] = JSON.parse(entry.topics || "[]");

  let html = `<a id="entry-${entry.id}" class="entry-card${isSelected ? " selected" : ""}" href="/projects/${encodeURIComponent(projectId)}/${entry.id}" hx-get="/api/journal/conversation?entry_id=${entry.id}" hx-target="#panel-detail">`;
  html += `<div class="entry-label">${formatDateShort(entry.date)}</div>`;
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
    html += `<ul class="entry-questions">`;
    for (const q of openQuestions) {
      html += `<li>${escapeHtml(q)}</li>`;
    }
    html += `</ul>`;
  }
  html += `<div class="entry-stats">${sessionIds.length} session${sessionIds.length !== 1 ? "s" : ""}</div>`;
  html += `</a>`;
  return html;
}

/** Render a suspense placeholder for an unsummarized date group */
function renderUnsummarizedPlaceholder(projectId: string, date: string, sessionCount: number): string {
  return `<div class="entry-card entry-card-pending" hx-get="/api/projects/summarize?project=${encodeURIComponent(projectId)}&date=${encodeURIComponent(date)}" hx-trigger="revealed" hx-swap="outerHTML" hx-request='{"timeout": 120000}'>
    <div class="entry-label">${formatDateShort(date)}</div>
    <div class="entry-summary" style="color: var(--text-ghost); font-style: italic;">Generating summary\u2026 (${sessionCount} session${sessionCount !== 1 ? "s" : ""})</div>
  </div>`;
}

/**
 * Panel 2: Timeline of entries for a project, grouped by time bucket.
 * Shows existing journal entries plus suspense placeholders for unsummarized dates.
 */
export function renderProjectTimeline(db: Database, projectId: string, selectedEntryId?: number, dayStartHour: number = 5): string {
  const project = db.query(`SELECT display_name FROM projects WHERE id = ?`).get(projectId) as { display_name: string } | null;
  const name = project?.display_name || projectId;

  // Get existing journal entries
  const entries = db.query(`
    SELECT je.id, je.date, je.headline, je.summary, je.topics, je.session_ids, je.open_questions
    FROM journal_entries je
    WHERE je.project_id = ? AND je.headline != ''
    ORDER BY je.date DESC
  `).all(projectId) as ProjectEntryRow[];

  // Find unsummarized date groups using the same logical-date calculation as the summarizer
  const unsummarizedGroups = groupSessionsByDateAndProject(db, undefined, projectId, dayStartHour);
  const unsummarizedRows = unsummarizedGroups.map(g => ({
    date: g.date,
    session_count: g.sessionIds.length,
  }));

  let html = `<div class="page-title">${escapeHtml(name)}</div>`;

  if (entries.length === 0 && unsummarizedRows.length === 0) {
    html += '<div class="empty-state">No entries for this project.</div>';
    return html;
  }

  // Merge summarized and unsummarized dates
  const summarizedDates = new Set(entries.map(e => e.date));
  const allDates = [...new Set([
    ...entries.map(e => e.date),
    ...unsummarizedRows.map(r => r.date),
  ])].sort((a, b) => b.localeCompare(a)); // desc

  const buckets = groupByTimeBucket(allDates);
  const entriesByDate = new Map<string, ProjectEntryRow[]>();
  for (const e of entries) {
    if (!entriesByDate.has(e.date)) entriesByDate.set(e.date, []);
    entriesByDate.get(e.date)!.push(e);
  }
  const unsummarizedByDate = new Map<string, number>();
  for (const r of unsummarizedRows) {
    unsummarizedByDate.set(r.date, r.session_count);
  }

  for (const [bucketName, bucketDates] of buckets) {
    html += `<div class="index-section-label" style="padding: 12px 0 6px; margin-top: 8px;">${escapeHtml(bucketName)}</div>`;
    for (const date of bucketDates) {
      if (summarizedDates.has(date)) {
        const dateEntries = entriesByDate.get(date) || [];
        for (const entry of dateEntries) {
          html += renderEntryCard(entry, projectId, entry.id === selectedEntryId);
        }
      } else {
        const count = unsummarizedByDate.get(date) || 0;
        html += renderUnsummarizedPlaceholder(projectId, date, count);
      }
    }
  }
  return html;
}

/**
 * Full page content for projects tab.
 */
export function renderProjectsPage(db: Database, projectId?: string, entryId?: number, exclude: string[] = [], dayStartHour: number = 5): {
  panel1: string;
  panel2: string;
  panel3: string;
} {
  // If no project specified, use the most recent (respecting exclude)
  if (!projectId) {
    const ex = excludeWhere(exclude);
    const row = db.query(`SELECT id FROM projects WHERE 1=1${ex.sql} ORDER BY last_session_at DESC LIMIT 1`).get(...ex.params) as { id: string } | null;
    projectId = row?.id;
  }

  const panel1 = renderProjectIndex(db, projectId, exclude);

  if (!projectId) {
    return { panel1, panel2: '<div class="empty-state">No projects yet.</div>', panel3: "" };
  }

  const panel2 = renderProjectTimeline(db, projectId, entryId ?? undefined, dayStartHour);

  // Default panel 3
  let panel3 = '<div class="empty-state">Select an entry to view conversations.</div>';
  if (entryId) {
    panel3 = renderEntryConversations(db, entryId);
  } else {
    const firstEntry = db.query(`
      SELECT id FROM journal_entries WHERE project_id = ? AND headline != '' ORDER BY date DESC LIMIT 1
    `).get(projectId) as { id: number } | null;
    if (firstEntry) {
      panel3 = renderEntryConversations(db, firstEntry.id);
    }
  }

  return { panel1, panel2, panel3 };
}
