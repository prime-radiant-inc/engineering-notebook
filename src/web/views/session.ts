import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "fs";
import { inferAssistantDisplayName, inferUserDisplayName, renderConversation } from "./conversation";
import { escapeHtml } from "./helpers";
import { listGroups, getSessionGroupId } from "../../groups";
import { parseTranscript, type TranscriptItem } from "../../transcript";

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

function toggleControls(sessionId: string, showThinking: boolean, showTools: boolean): string {
  const url = (t: boolean, o: boolean) => {
    const params: string[] = [];
    if (t) params.push("thinking=1");
    if (o) params.push("tools=1");
    return `/session/${encodeURIComponent(sessionId)}${params.length ? "?" + params.join("&amp;") : ""}`;
  };
  const thinkingLink = url(!showThinking, showTools);
  const toolsLink = url(showThinking, !showTools);
  return (
    `<div class="transcript-toggle">` +
    `<a href="${thinkingLink}">${showThinking ? "Hide thinking" : "Show thinking"}</a>` +
    `<a href="${toolsLink}">${showTools ? "Hide tools" : "Show tools"}</a>` +
    `</div>`
  );
}

export function toolPreview(name: string | undefined, input: Record<string, unknown> | undefined): string {
  if (!name || !input) return "";
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  switch (name) {
    case "Read": case "Write": case "Edit": return s(input.file_path);
    case "Bash": return s(input.command).slice(0, 80);
    case "Glob": case "Grep": return s(input.pattern);
    case "Task": return s(input.description);
    case "WebFetch": return s(input.url);
    default: return "";
  }
}

function renderTranscriptItems(items: TranscriptItem[], showThinking: boolean, showTools: boolean): string {
  const resultsByToolUseId = new Map<string, string>();
  for (const it of items) {
    if (it.kind === "tool_result" && it.toolUseId && !resultsByToolUseId.has(it.toolUseId)) {
      resultsByToolUseId.set(it.toolUseId, it.content);
    }
  }
  const toolUseIds = new Set<string>();
  for (const it of items) {
    if (it.kind === "tool_use" && it.id) toolUseIds.add(it.id);
  }

  let html = "";
  let hadThinking = false;
  let hadTool = false;
  for (const item of items) {
    if (item.kind === "thinking") { hadThinking = true; if (!showThinking) continue; }
    if (item.kind === "tool_use" || item.kind === "tool_result") { hadTool = true; if (!showTools) continue; }

    if (item.kind === "text") {
      const who = item.role === "user" ? "User" : "Assistant";
      html += `<div style="margin-bottom:12px;"><div style="font-size:11px; color:var(--text-ghost);">${who}</div><div>${escapeHtml(item.content)}</div></div>`;
    } else if (item.kind === "thinking") {
      const tokens = item.content.length > 100
        ? `<span class="tokens">~${Math.round(item.content.length / 4).toLocaleString()} tokens</span>`
        : "";
      html += `<div class="transcript-thinking">${escapeHtml(item.content)}${tokens}</div>`;
    } else if (item.kind === "tool_use") {
      const preview = toolPreview(item.name, item.input);
      const body = escapeHtml(item.input ? JSON.stringify(item.input, null, 2) : item.content);
      let resultHtml = "";
      if (item.id && resultsByToolUseId.has(item.id)) {
        resultHtml = `<div class="tool-result"><pre>${escapeHtml(resultsByToolUseId.get(item.id)!)}</pre></div>`;
      }
      html += `<details class="transcript-tool"><summary><span class="tool-name">${escapeHtml(item.name || "tool")}</span>` +
        (preview ? `<span class="tool-preview">${escapeHtml(preview)}</span>` : "") +
        `</summary><pre>${body}</pre>${resultHtml}</details>`;
    } else { // tool_result
      if (item.toolUseId && toolUseIds.has(item.toolUseId)) continue; // paired inside its tool_use (any order)
      html += `<div class="transcript-tool" style="display:block;"><div style="font-weight:600; color:var(--text-muted);">&#8627; result</div><pre>${escapeHtml(item.content)}</pre></div>`;
    }
  }

  if (showThinking && !hadThinking) {
    html += `<div style="color:var(--text-ghost); font-style:italic; font-size:12px;">No thinking data for this session.</div>`;
  }
  if (showTools && !hadTool) {
    html += `<div style="color:var(--text-ghost); font-style:italic; font-size:12px;">No tool data for this session.</div>`;
  }
  return html;
}

/**
 * Render a single session's conversation for Panel 3,
 * with basic session metadata header.
 */
export function renderSessionDetail(
  db: Database,
  sessionId: string,
  opts: { showThinking?: boolean; showTools?: boolean } = {}
): string {
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
  html += `</div>`;
  html += `<div style="font-size: 11px; color: var(--text-ghost); margin-top: 2px; font-family: monospace;">${escapeHtml(session.id)}</div>`;
  html += `</div>`;

  const groups = listGroups(db);
  const currentGroupId = getSessionGroupId(db, sessionId);
  html += `<form action="/sessions/${escapeHtml(sessionId)}/group" method="post" style="margin-bottom:16px; display:flex; gap:8px; align-items:center;">`;
  html += `<label style="font-size:11px; color:var(--text-ghost);">Group</label>`;
  html += `<select name="group_id" onchange="this.form.submit()" style="flex:1;">`;
  html += `<option value=""${currentGroupId === null ? " selected" : ""}>None</option>`;
  for (const g of groups) {
    html += `<option value="${g.id}"${currentGroupId === g.id ? " selected" : ""}>${escapeHtml(g.name)}</option>`;
  }
  html += `</select>`;
  html += `<noscript><button type="submit">Save</button></noscript>`;
  html += `</form>`;

  const showThinking = opts.showThinking ?? false;
  const showTools = opts.showTools ?? false;
  html += toggleControls(sessionId, showThinking, showTools);

  if (showThinking || showTools) {
    if (session.source_path && existsSync(session.source_path)) {
      try {
        const { items } = parseTranscript(readFileSync(session.source_path, "utf-8"));
        html += renderTranscriptItems(items, showThinking, showTools);
        html += renderSessionFooter(sessionId, session.project_path, session.source_path);
        return html;
      } catch {
        html += `<div class="transcript-warning">Original session file unavailable — can't show thinking/tools.</div>`;
      }
    } else {
      html += `<div class="transcript-warning">Original session file unavailable — can't show thinking/tools.</div>`;
    }
    // fall through to text-only render below
  }

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
