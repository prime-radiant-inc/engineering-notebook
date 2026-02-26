import { Database } from "bun:sqlite";
import { inferAssistantDisplayName, inferUserDisplayName, renderConversation } from "./conversation";
import { escapeHtml } from "./helpers";

/**
 * Render a resume command footer with copy button and source path.
 */
export function renderSessionFooter(sessionId: string, projectPath: string, sourcePath: string): string {
  const isCodexSession = sourcePath.includes("/.codex/sessions/");
  const resumeCmd = isCodexSession
    ? `cd ${projectPath} && codex resume ${sessionId}`
    : `cd ${projectPath} && claude --resume ${sessionId}`;
  let html = `<div class="session-footer">`;
  html += `<div class="session-footer-resume">`;
  html += `<code>${escapeHtml(resumeCmd)}</code>`;
  html += ` <button class="copy-btn" onclick="navigator.clipboard.writeText(this.previousElementSibling.textContent)">Copy</button>`;
  html += `</div>`;
  html += `<div class="session-footer-source">${escapeHtml(sourcePath)}</div>`;
  html += `</div>`;
  return html;
}

/**
 * Render a single session's conversation for Panel 3,
 * with basic session metadata header.
 */
export function renderSessionDetail(db: Database, sessionId: string): string {
  const session = db.query(`
    SELECT s.id, s.project_id, s.project_path, s.source_path, s.started_at, s.ended_at, s.git_branch,
           s.message_count, p.display_name, c.conversation_markdown
    FROM sessions s
    JOIN projects p ON s.project_id = p.id
    LEFT JOIN conversations c ON c.session_id = s.id
    WHERE s.id = ?
  `).get(sessionId) as {
    id: string; project_id: string; project_path: string; source_path: string;
    started_at: string; ended_at: string | null;
    git_branch: string | null; message_count: number; display_name: string;
    conversation_markdown: string | null;
  } | null;

  if (!session) return '<div class="empty-state">Session not found.</div>';

  let html = `<button class="panel-dismiss" onclick="this.parentElement.innerHTML='<div class=\\'empty-state\\'>Select a session to view.</div>'">&times;</button>`;
  html += `<div style="margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--border-subtle);">`;
  html += `<div style="font-size: 13px; font-weight: 600; color: var(--text);">${escapeHtml(session.display_name)}</div>`;
  html += `<div style="font-size: 11px; color: var(--text-ghost); margin-top: 2px;">`;
  html += `${session.started_at.slice(0, 10)} · ${session.message_count} messages`;
  if (session.git_branch) html += ` · ${escapeHtml(session.git_branch)}`;
  html += `</div></div>`;

  if (session.conversation_markdown) {
    html += renderConversation(
      session.conversation_markdown,
      inferUserDisplayName(session.project_path),
      inferAssistantDisplayName(session.source_path)
    );
  } else {
    html += '<div class="empty-state">No conversation data.</div>';
  }

  html += renderSessionFooter(sessionId, session.project_path, session.source_path);

  return html;
}
