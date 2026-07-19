import { Database } from "bun:sqlite";
import { escapeHtml } from "./helpers";
import { listGroups, getGroupWithSessions } from "../../groups";

export function renderGroupsIndex(db: Database, error?: string): string {
  const groups = listGroups(db);
  let html = `<div style="max-width: 720px; margin: 0 auto; padding: 24px;">`;
  html += `<div class="page-title">Groups</div>`;

  if (error) {
    html += `<div style="color:#b91c1c; margin-bottom:12px;">${escapeHtml(error)}</div>`;
  }

  html += `<form action="/groups" method="post" style="display:flex; gap:8px; margin-bottom:20px;">`;
  html += `<input type="text" name="name" placeholder="New group name" style="flex:1;" required>`;
  html += `<button type="submit">Create</button>`;
  html += `</form>`;

  if (groups.length === 0) {
    html += `<div class="empty-state">No groups yet. Create one above.</div>`;
  } else {
    for (const g of groups) {
      const activity = g.lastActivityAt ? g.lastActivityAt.slice(0, 10) : "—";
      html += `<div style="padding:10px 0; border-bottom:1px solid var(--border-subtle); display:flex; justify-content:space-between;">`;
      html += `<a href="/groups/${g.id}">${escapeHtml(g.name)}</a>`;
      html += `<span style="color:var(--text-ghost); font-size:12px;">${g.sessionCount} session(s) · ${activity}</span>`;
      html += `</div>`;
    }
  }

  html += `</div>`;
  return html;
}

export function renderGroupDetail(db: Database, id: number): string | null {
  const data = getGroupWithSessions(db, id);
  if (!data) return null;
  const { group, sessions } = data;

  let html = `<div style="max-width: 720px; margin: 0 auto; padding: 24px;">`;
  html += `<div style="margin-bottom:16px;"><a href="/groups">&larr; Groups</a></div>`;

  html += `<form action="/groups/${group.id}/rename" method="post" style="display:flex; gap:8px; margin-bottom:8px;">`;
  html += `<input type="text" name="name" value="${escapeHtml(group.name)}" style="flex:1; font-size:18px; font-weight:700;" required>`;
  html += `<button type="submit">Rename</button>`;
  html += `</form>`;

  html += `<form action="/groups/${group.id}/delete" method="post" style="margin-bottom:20px;" onsubmit="return confirm('Delete this group? Its sessions become ungrouped.')">`;
  html += `<button type="submit">Delete group</button>`;
  html += `</form>`;

  if (sessions.length === 0) {
    html += `<div class="empty-state">No sessions in this group yet.</div>`;
  } else {
    for (const s of sessions) {
      html += `<div style="padding:8px 0; border-bottom:1px solid var(--border-subtle);">`;
      html += `<a href="/session/${escapeHtml(s.id)}">${escapeHtml(s.display_name)}</a>`;
      html += `<div style="color:var(--text-ghost); font-size:12px;">${s.started_at.slice(0, 10)} · ${s.message_count} messages · ${escapeHtml(s.project_id)}</div>`;
      html += `</div>`;
    }
  }

  html += `</div>`;
  return html;
}
