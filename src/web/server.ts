import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { renderLayout } from "./views/layout";
import { renderJournalPage, renderJournalEntries, renderEntryConversations, renderJournalDateIndex } from "./views/journal";
import { renderProjectsPage, renderProjectTimeline, renderProjectIndex } from "./views/projects";
import { renderSearch, renderSearchResults } from "./views/search";
import { renderSettings, renderRemoteSourceCard, renderSyncStatus } from "./views/settings";
import { renderSessionDetail } from "./views/session";
import { renderCalendarPage, renderIcalFeed, weekMonday } from "./views/calendar";
import { renderGroupsIndex, renderGroupDetail } from "./views/groups";
import { createGroup, renameGroup, deleteGroup, assignSession } from "../groups";
import { escapeHtml } from "./views/helpers";
import { loadConfig, saveConfig, resolveConfigPath, type RemoteSource } from "../config";
import type { SyncManager } from "../sync";

export function createApp(db: Database, syncManager: SyncManager): Hono {
  const app = new Hono();

  // ──────────────────────────────────────────
  // Full-page routes
  // ──────────────────────────────────────────

  // Journal (default landing page)
  app.get("/", (c) => {
    const date = c.req.query("date");
    const entryId = c.req.query("entry") ? parseInt(c.req.query("entry")!) : undefined;
    const { panel1, panel2, panel3 } = renderJournalPage(db, date, entryId);
    return c.html(renderLayout("Engineering Notebook", {
      activeTab: "journal",
      panel1,
      panel2,
      panel3,
    }));
  });

  // Projects — path-based routes (new, canonical)
  app.get("/projects/:project/:entry", (c) => {
    const config = loadConfig();
    const projectId = c.req.param("project");
    const entryId = parseInt(c.req.param("entry"));
    const { panel1, panel2, panel3 } = renderProjectsPage(db, projectId, isNaN(entryId) ? undefined : entryId, config.exclude, config.day_start_hour);
    return c.html(renderLayout("Projects — Engineering Notebook", {
      activeTab: "projects",
      panel1,
      panel2,
      panel3,
    }));
  });

  app.get("/projects/:project", (c) => {
    const config = loadConfig();
    const projectId = c.req.param("project");
    const { panel1, panel2, panel3 } = renderProjectsPage(db, projectId, undefined, config.exclude, config.day_start_hour);
    return c.html(renderLayout("Projects — Engineering Notebook", {
      activeTab: "projects",
      panel1,
      panel2,
      panel3,
    }));
  });

  // Projects — query-param routes (kept for backwards compatibility)
  app.get("/projects", (c) => {
    const config = loadConfig();
    const projectId = c.req.query("project") || undefined;
    const entryId = c.req.query("entry") ? parseInt(c.req.query("entry")!) : undefined;
    const { panel1, panel2, panel3 } = renderProjectsPage(db, projectId, entryId, config.exclude, config.day_start_hour);
    return c.html(renderLayout("Projects — Engineering Notebook", {
      activeTab: "projects",
      panel1,
      panel2,
      panel3,
    }));
  });

  // Session detail — show in journal context
  app.get("/session/:id", (c) => {
    const sessionId = c.req.param("id");
    const showThinking = c.req.query("thinking") === "1";
    const showTools = c.req.query("tools") === "1";
    const panel3 = renderSessionDetail(db, sessionId, { showThinking, showTools });
    // Find the date for this session to select it in the index
    const session = db.query(`SELECT date(started_at) as date FROM sessions WHERE id = ?`).get(sessionId) as { date: string } | null;
    const date = session?.date;
    const panel1 = renderJournalDateIndex(db, date || undefined);
    const panel2 = date ? renderJournalEntries(db, date) : '<div class="empty-state">Session not found.</div>';
    return c.html(renderLayout("Session — Engineering Notebook", {
      activeTab: "journal",
      panel1,
      panel2,
      panel3,
    }));
  });

  // Search
  app.get("/search", (c) => {
    const q = c.req.query("q") || "";
    if (c.req.header("HX-Request")) {
      return c.html(renderSearchResults(db, q));
    }
    return c.html(renderLayout("Search — Engineering Notebook", { body: renderSearch(db, q) }));
  });

  // Calendar
  app.get("/calendar", (c) => {
    const config = loadConfig();
    const mode = (c.req.query("mode") === "month" ? "month" : "week") as "week" | "month";
    const today = new Date().toISOString().slice(0, 10);
    const ref = c.req.query("ref") || (mode === "month" ? today.slice(0, 7) + "-01" : weekMonday(today));
    const calendarHtml = renderCalendarPage(db, mode, ref, config.exclude);
    if (c.req.header("HX-Request")) {
      return c.html(calendarHtml);
    }
    const fullBody = `<div id="calendar-page">${calendarHtml}</div>`;
    return c.html(renderLayout("Calendar — Engineering Notebook", { fullBody, activeTab: "calendar" }));
  });

  // iCal feed
  app.get("/api/calendar.ics", (c) => {
    const config = loadConfig();
    const ical = renderIcalFeed(db, config.exclude);
    return new Response(ical, {
      headers: { "Content-Type": "text/calendar; charset=utf-8" },
    });
  });

  // Settings (GET)
  app.get("/settings", (c) => {
    const config = loadConfig();
    return c.html(renderLayout("Settings — Engineering Notebook", { body: renderSettings(config) }));
  });

  // Settings (POST)
  app.post("/settings", async (c) => {
    const body = await c.req.parseBody();
    const config = loadConfig();
    const configPath = resolveConfigPath();

    config.summary_instructions = (body.summary_instructions as string) || "";
    const dayStart = parseInt((body.day_start_hour as string) || "5", 10);
    config.day_start_hour = isNaN(dayStart) ? 5 : Math.max(0, Math.min(23, dayStart));
    config.sources = ((body.sources as string) || "").split("\n").map(s => s.trim()).filter(Boolean);
    config.exclude = ((body.exclude as string) || "").split("\n").map(s => s.trim()).filter(Boolean);
    const port = parseInt((body.port as string) || "3000", 10);
    config.port = isNaN(port) ? 3000 : Math.max(1, Math.min(65535, port));

    // Parse remote sources — indices may be non-sequential (timestamp-based from HTMX adds)
    const remoteSources: RemoteSource[] = [];
    const remoteIndices = Object.keys(body)
      .filter((k) => k.startsWith("remote_name_"))
      .map((k) => k.replace("remote_name_", ""));
    for (const idx of remoteIndices) {
      const name = body[`remote_name_${idx}`] as string;
      if (!name) continue;
      remoteSources.push({
        name,
        host: (body[`remote_host_${idx}`] as string) || "",
        path: (body[`remote_path_${idx}`] as string) || "~/.claude/projects",
        enabled: body[`remote_enabled_${idx}`] === "on",
      });
    }
    config.remote_sources = remoteSources;

    const autoSync = parseInt((body.auto_sync_interval as string) || "60", 10);
    config.auto_sync_interval = isNaN(autoSync) ? 60 : Math.max(0, autoSync);

    saveConfig(configPath, config);
    syncManager.updateConfig(config);
    return c.redirect("/settings");
  });

  // ──────────────────────────────────────────
  // HTMX partial routes (return panel HTML fragments)
  // ──────────────────────────────────────────

  // Journal: load entries for a date (Panel 2)
  app.get("/api/journal/entries", (c) => {
    const date = c.req.query("date");
    if (!date) return c.text("Missing date", 400);
    return c.html(renderJournalEntries(db, date));
  });

  // Journal: load conversation for an entry (Panel 3)
  app.get("/api/journal/conversation", (c) => {
    const entryId = parseInt(c.req.query("entry_id") || "0");
    const sessionIdx = parseInt(c.req.query("session_idx") || "0");
    if (!entryId) return c.text("Missing entry_id", 400);
    return c.html(renderEntryConversations(db, entryId, sessionIdx));
  });

  // Projects: load timeline for a project (Panel 2)
  app.get("/api/projects/timeline", (c) => {
    const config = loadConfig();
    const projectId = c.req.query("project");
    if (!projectId) return c.text("Missing project", 400);
    return c.html(renderProjectTimeline(db, projectId, undefined, config.day_start_hour));
  });

  // Legacy route compatibility: /project/:id redirects to /projects/:id
  app.get("/project/:id", (c) => {
    const projectId = c.req.param("id");
    return c.redirect(`/projects/${encodeURIComponent(projectId)}`);
  });

  // Projects: on-demand summarize a single project+date
  app.get("/api/projects/summarize", async (c) => {
    const projectId = c.req.query("project");
    const date = c.req.query("date");
    if (!projectId || !date) return c.text("Missing project or date", 400);

    try {
      const entryId = await syncManager.summarizeGroup(projectId, date);
      if (entryId) {
        // Fetch the newly created entry and render it as a card
        const entry = db.query(`
          SELECT id, date, headline, summary, topics, session_ids, open_questions
          FROM journal_entries WHERE id = ?
        `).get(entryId) as { id: number; date: string; headline: string; summary: string; topics: string; session_ids: string; open_questions: string } | null;
        if (entry) {
          const { renderEntryCard } = await import("./views/projects");
          return c.html(renderEntryCard(entry, projectId, false));
        }
      }
      // Skipped or no groups — show a muted card
      return c.html(`<div class="entry-card" style="opacity: 0.5;">
        <div class="entry-label">${date}</div>
        <div class="entry-summary" style="color: var(--text-ghost); font-style: italic;">No journal-worthy sessions on this date.</div>
      </div>`);
    } catch (err) {
      return c.html(`<div class="entry-card" style="opacity: 0.5;">
        <div class="entry-label">${date}</div>
        <div class="entry-summary" style="color: #b91c1c; font-style: italic;">Summary failed: ${escapeHtml(String(err))}</div>
      </div>`);
    }
  });

  // Sync: trigger sync+ingest
  app.post("/api/sync", (c) => {
    syncManager.runSync();
    return c.html(renderSyncStatus(syncManager.getStatus()));
  });

  // Summarize: trigger bulk summarization
  app.post("/api/summarize", (c) => {
    syncManager.runSummarize();
    return c.html(renderSyncStatus(syncManager.getStatus()));
  });

  // Sync: get current status
  app.get("/api/sync/status", (c) => {
    return c.html(renderSyncStatus(syncManager.getStatus()));
  });

  // Remote sources: new card fragment
  app.get("/api/settings/remote-source-card", (c) => {
    const index = parseInt(c.req.query("index") || "0", 10);
    // Count existing cards by finding the next available index
    // The client doesn't send the count, so we use a JS-assigned index via htmx
    // For simplicity, use a timestamp-based index to avoid collisions
    const idx = index || Date.now();
    return c.html(renderRemoteSourceCard(idx));
  });

  // Remote sources: test SSH connection
  app.post("/api/settings/test-connection", async (c) => {
    const body = await c.req.parseBody();
    // hx-include sends the field by its indexed name, so find any remote_host_* field
    const host = Object.entries(body)
      .find(([k]) => k.startsWith("remote_host_"))?.[1] as string || "";
    if (!host) {
      return c.html(`<span class="connection-error">No host specified</span>`);
    }
    const { testConnection } = await import("../sync");
    const error = await testConnection(host);
    if (error) {
      return c.html(`<span class="connection-error">${escapeHtml(error)}</span>`);
    }
    return c.html(`<span class="connection-ok">Connected</span>`);
  });

  // ──────────────────────────────────────────
  // Groups
  // ──────────────────────────────────────────

  app.get("/groups", (c) => {
    const error = c.req.query("error") || undefined;
    return c.html(renderLayout("Groups — Engineering Notebook", {
      body: renderGroupsIndex(db, error),
      activeTab: "groups",
    }));
  });

  app.get("/groups/:id", (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const body = isNaN(id) ? null : renderGroupDetail(db, id);
    if (!body) return c.text("Group not found", 404);
    return c.html(renderLayout("Group — Engineering Notebook", {
      body,
      activeTab: "groups",
    }));
  });

  app.post("/groups", async (c) => {
    const form = await c.req.parseBody();
    try {
      createGroup(db, (form.name as string) || "");
    } catch (err) {
      return c.html(renderLayout("Groups — Engineering Notebook", {
        body: renderGroupsIndex(db, String(err instanceof Error ? err.message : err)),
        activeTab: "groups",
      }));
    }
    return c.redirect("/groups");
  });

  app.post("/groups/:id/rename", async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const form = await c.req.parseBody();
    try {
      renameGroup(db, id, (form.name as string) || "");
    } catch (err) {
      return c.html(renderLayout("Groups — Engineering Notebook", {
        body: renderGroupsIndex(db, String(err instanceof Error ? err.message : err)),
        activeTab: "groups",
      }));
    }
    return c.redirect(`/groups/${id}`);
  });

  app.post("/groups/:id/delete", (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!isNaN(id)) deleteGroup(db, id);
    return c.redirect("/groups");
  });

  app.post("/sessions/:id/group", async (c) => {
    const sessionId = c.req.param("id");
    const form = await c.req.parseBody();
    const raw = (form.group_id as string) || "";
    const groupId = raw === "" ? null : parseInt(raw, 10);
    try {
      assignSession(db, sessionId, groupId === null || isNaN(groupId) ? null : groupId);
    } catch {
      // invalid/stale group_id (e.g. group deleted in another tab) — ignore, don't 500
    }
    return c.redirect(`/session/${encodeURIComponent(sessionId)}`);
  });

  return app;
}
