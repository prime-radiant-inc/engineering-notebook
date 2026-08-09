import { escapeHtml } from "./helpers";
import type { Config, RemoteSource } from "../../config";
import type { SyncStatus, SummarizeStats } from "../../sync";

export function renderRemoteSourceCard(
  index: number,
  source?: RemoteSource
): string {
  const name = source?.name ?? "";
  const host = source?.host ?? "";
  const path = source?.path ?? "~/.claude/projects";
  const enabled = source?.enabled ?? true;

  return `<div class="remote-source-card">
    <div class="remote-source-fields">
      <label class="remote-source-field">
        <span class="remote-source-field-label">Name</span>
        <input class="settings-input" type="text" name="remote_name_${index}" value="${escapeHtml(name)}" placeholder="e.g. Work MacBook">
      </label>
      <label class="remote-source-field">
        <span class="remote-source-field-label">Host</span>
        <input class="settings-input" type="text" name="remote_host_${index}" value="${escapeHtml(host)}" placeholder="e.g. jesse@macbook.local">
      </label>
      <label class="remote-source-field">
        <span class="remote-source-field-label">Path</span>
        <input class="settings-input" type="text" name="remote_path_${index}" value="${escapeHtml(path)}" placeholder="~/.claude/projects or ~/.codex/sessions">
      </label>
    </div>
    <div class="remote-source-actions">
      <label class="remote-source-toggle">
        <input type="checkbox" name="remote_enabled_${index}" ${enabled ? "checked" : ""}> Enabled
      </label>
      <button type="button" class="settings-btn-secondary"
        hx-post="/hx/settings/test-connection"
        hx-include="[name=remote_host_${index}]"
        hx-target="next .connection-status" hx-swap="innerHTML">Test Connection</button>
      <span class="connection-status"></span>
      <button type="button" class="settings-btn-danger" onclick="this.closest('.remote-source-card').remove()">Remove</button>
    </div>
  </div>`;
}

export function renderSyncStatus(status: SyncStatus): string {
  const polling = status.inProgress || status.summarizeInProgress;
  const trigger = polling ? `hx-trigger="load, every 5s"` : `hx-trigger="load"`;

  if (!status.lastRun && !status.inProgress && !status.summarizeInProgress) {
    return `<div class="sync-status-panel" ${trigger} hx-get="/hx/sync/status" hx-swap="outerHTML">
      <div class="sync-stats">No sync has run yet.</div>
    </div>`;
  }

  let html = `<div class="sync-status-panel" ${trigger} hx-get="/hx/sync/status" hx-swap="outerHTML">`;

  if (status.inProgress) {
    html += `<div class="sync-status-spinner">Syncing\u2026</div>`;

    // Show partial results as they come in
    if (status.lastResults.length > 0) {
      html += `<div class="sync-results">`;
      for (const r of status.lastResults) {
        if (r.success) {
          html += `<span class="sync-result-ok">\u2713 ${escapeHtml(r.name)}</span>`;
        } else {
          html += `<span class="sync-result-error">\u2717 ${escapeHtml(r.name)}: ${escapeHtml(r.error || "unknown error")}</span>`;
        }
      }
      html += `</div>`;
    }
  } else if (status.lastRun) {
    const ago = formatTimeAgo(status.lastRun);
    html += `<div class="sync-stats">Last sync: ${escapeHtml(ago)}</div>`;

    if (status.lastResults.length > 0) {
      html += `<div class="sync-results">`;
      for (const r of status.lastResults) {
        if (r.success) {
          html += `<span class="sync-result-ok">\u2713 ${escapeHtml(r.name)}</span>`;
        } else {
          html += `<span class="sync-result-error">\u2717 ${escapeHtml(r.name)}: ${escapeHtml(r.error || "unknown error")}</span>`;
        }
      }
      html += `</div>`;
    }

    if (status.lastIngestStats) {
      const s = status.lastIngestStats;
      html += `<div class="sync-stats">Ingested: ${s.ingested}, Skipped: ${s.skipped}, Errors: ${s.errors}</div>`;
    }
  }

  if (status.summarizeInProgress) {
    html += `<div class="sync-status-spinner">Summarizing\u2026</div>`;
  } else if (status.lastSummarizeRun) {
    const ago = formatTimeAgo(status.lastSummarizeRun);
    html += `<div class="sync-stats">Last summarize: ${escapeHtml(ago)}</div>`;
    if (status.lastSummarizeStats) {
      const s = status.lastSummarizeStats;
      html += `<div class="sync-stats">Summarized: ${s.summarized}, Skipped: ${s.skipped}, Errors: ${s.errors}</div>`;
    }
  }

  html += `</div>`;
  return html;
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function renderSettings(config: Config): string {
  let html = `<div class="page-title">Settings</div>`;
  html += `<form method="POST" action="/settings">`;

  // Summary instructions
  html += `<div class="settings-group">`;
  html += `<div class="settings-label">Custom Summary Instructions</div>`;
  html += `<div class="settings-help">Additional context sent to the LLM when generating summaries. E.g., "Focus on architectural decisions" or "Include commit hashes".</div>`;
  html += `<textarea class="settings-input" name="summary_instructions" rows="4">${escapeHtml(config.summary_instructions)}</textarea>`;
  html += `</div>`;

  // Day start hour
  html += `<div class="settings-group">`;
  html += `<div class="settings-label">Day Start Hour</div>`;
  html += `<div class="settings-help">Hour (0\u201323) when a new "logical day" begins. Messages before this hour belong to the previous day. Default: 5 (5 AM).</div>`;
  html += `<input class="settings-input" type="number" name="day_start_hour" min="0" max="23" value="${config.day_start_hour}" style="width: 80px;">`;
  html += `</div>`;

  // Source directories
  html += `<div class="settings-group">`;
  html += `<div class="settings-label">Source Directories</div>`;
  html += `<div class="settings-help">Paths to scan for Claude Code or Codex session JSONL files (one per line).</div>`;
  html += `<textarea class="settings-input" name="sources" rows="3">${escapeHtml(config.sources.join("\n"))}</textarea>`;
  html += `</div>`;

  // Excluded patterns
  html += `<div class="settings-group">`;
  html += `<div class="settings-label">Excluded Patterns</div>`;
  html += `<div class="settings-help">Glob patterns to skip during ingestion (one per line).</div>`;
  html += `<textarea class="settings-input" name="exclude" rows="3">${escapeHtml(config.exclude.join("\n"))}</textarea>`;
  html += `</div>`;

  // Remote sources
  html += `<div class="settings-group">`;
  html += `<div class="settings-label">Remote Sources</div>`;
  html += `<div class="settings-help">Sync Claude/Codex sessions from other machines via SSH. Requires passwordless SSH (key-based auth). Run: <code>ssh-copy-id user@host</code></div>`;
  html += `<div id="remote-sources-list">`;
  const remoteSources = config.remote_sources || [];
  for (let i = 0; i < remoteSources.length; i++) {
    html += renderRemoteSourceCard(i, remoteSources[i]);
  }
  html += `</div>`;
  html += `<button type="button" class="settings-btn-secondary" hx-get="/hx/settings/remote-source-card" hx-target="#remote-sources-list" hx-swap="beforeend">+ Add Remote Source</button>`;
  html += `</div>`;

  // Sync
  html += `<div class="settings-group">`;
  html += `<div class="settings-label">Sync</div>`;
  html += `<div class="settings-help">Auto-sync interval in minutes (0 = disabled). Periodically syncs remote sources and ingests new sessions.</div>`;
  html += `<div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">`;
  html += `<input class="settings-input" type="number" name="auto_sync_interval" min="0" value="${config.auto_sync_interval}" style="width: 80px;">`;
  html += `<span style="font-size: 12px; color: var(--text-faint);">minutes</span>`;
  html += `</div>`;
  html += `<div style="display: flex; gap: 8px;">`;
  html += `<button type="button" class="settings-btn-secondary" hx-post="/hx/sync" hx-target="#sync-status" hx-swap="innerHTML">Sync Now</button>`;
  html += `<button type="button" class="settings-btn-secondary" hx-post="/hx/summarize" hx-target="#sync-status" hx-swap="innerHTML">Summarize All</button>`;
  html += `</div>`;
  html += `<div id="sync-status" style="margin-top: 12px;">`;
  html += `<div hx-get="/hx/sync/status" hx-trigger="load" hx-swap="outerHTML"></div>`;
  html += `</div>`;
  html += `</div>`;

  // Calendar feed
  html += `<div class="settings-group">`;
  html += `<div class="settings-label">Calendar Feed</div>`;
  html += `<div class="settings-help">Subscribe in Apple Calendar or any iCal-compatible app.</div>`;
  const icalUrl = `webcal://localhost:${config.port}/api/calendar.ics`;
  html += `<div style="display: flex; align-items: center; gap: 8px;">`;
  html += `<code style="font-size: 12px; user-select: all;">${escapeHtml(icalUrl)}</code>`;
  html += `<button type="button" class="settings-btn-secondary" onclick="navigator.clipboard.writeText('${icalUrl}');this.textContent='Copied!';setTimeout(()=>this.textContent='Copy URL',1500)">Copy URL</button>`;
  html += `</div>`;
  html += `</div>`;

  // Port
  html += `<div class="settings-group">`;
  html += `<div class="settings-label">Server Port</div>`;
  html += `<input class="settings-input" type="number" name="port" value="${config.port}" style="width: 100px;">`;
  html += `</div>`;

  html += `<button class="settings-btn" type="submit">Save Settings</button>`;
  html += `</form>`;
  return html;
}
