import { Database } from "bun:sqlite";
import { escapeHtml } from "./helpers";

export function renderSearch(db: Database, query: string): string {
  let html = `<div class="page-title">Search</div>`;
  html += `<input class="search-box" type="text" name="q" placeholder="Search journal entries and conversations..."
    hx-get="/search" hx-trigger="keyup changed delay:300ms" hx-target="#results" hx-include="this"
    value="${escapeHtml(query)}">`;
  html += `<div id="results">`;
  if (query) {
    html += renderSearchResults(db, query);
  }
  html += `</div>`;
  return html;
}

export function renderSearchResults(db: Database, query: string): string {
  const pattern = `%${query}%`;

  const journalResults = db.query(`
    SELECT je.id, je.date, je.project_id, p.display_name, je.headline, je.summary, je.topics
    FROM journal_entries je
    JOIN projects p ON je.project_id = p.id
    WHERE (je.summary LIKE ? OR je.topics LIKE ? OR je.headline LIKE ?) AND je.headline != ''
    ORDER BY je.date DESC
    LIMIT 20
  `).all(pattern, pattern, pattern) as {
    id: number; date: string; project_id: string; display_name: string;
    headline: string; summary: string; topics: string;
  }[];

  const convoResults = db.query(`
    SELECT s.id as session_id, date(s.started_at) as date, p.display_name, s.project_id
    FROM conversations c
    JOIN sessions s ON c.session_id = s.id
    JOIN projects p ON s.project_id = p.id
    WHERE c.conversation_markdown LIKE ?
    ORDER BY s.started_at DESC
    LIMIT 20
  `).all(pattern) as { session_id: string; date: string; display_name: string; project_id: string }[];

  let html = "";

  if (journalResults.length > 0) {
    html += `<div style="margin-bottom: 24px;">`;
    html += `<div class="index-section-label" style="padding: 8px 0;">Journal Entries (${journalResults.length})</div>`;
    for (const r of journalResults) {
      html += `<a class="entry-card" href="/?date=${r.date}&entry=${r.id}" style="display:block;">`;
      html += `<div class="entry-label">${escapeHtml(r.display_name)} · ${r.date}</div>`;
      if (r.headline) {
        html += `<div class="entry-headline">${highlightMatch(escapeHtml(r.headline), query)}</div>`;
      }
      html += `<div class="entry-summary">${highlightMatch(escapeHtml(r.summary), query)}</div>`;
      html += `</a>`;
    }
    html += `</div>`;
  }

  if (convoResults.length > 0) {
    html += `<div>`;
    html += `<div class="index-section-label" style="padding: 8px 0;">Conversations (${convoResults.length})</div>`;
    for (const r of convoResults) {
      html += `<a class="entry-card" href="/session/${r.session_id}" style="display:block;">`;
      html += `<div class="entry-label">${escapeHtml(r.display_name)} · ${r.date}</div>`;
      html += `<div class="entry-summary">View session</div>`;
      html += `</a>`;
    }
    html += `</div>`;
  }

  if (journalResults.length === 0 && convoResults.length === 0) {
    html += `<div class="empty-state">No results for "${escapeHtml(query)}"</div>`;
  }

  return html;
}

function highlightMatch(text: string, query: string): string {
  if (!query) return text;
  const regex = new RegExp(`(${escapeRegex(query)})`, "gi");
  return text.replace(regex, `<mark>$1</mark>`);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
