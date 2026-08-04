import { Database } from "bun:sqlite";
import { escapeHtml } from "./helpers";
import { latestReport, NoEntriesError } from "../../reports";
import { renderMarkdown } from "./markdown";

export type JobState = "pending" | "done" | "empty" | "error";
export type Job = { state: JobState; error?: string; week?: string };

/**
 * In-memory job registry. Generation takes 1-2 minutes, which is too long for a
 * request. A restart loses job *status* but never a report: generateReport
 * commits before the job is marked done, so a lost job just means the user
 * refreshes and finds the report already there.
 *
 * `week` is carried on the job so the "done" poll response can send the
 * browser back to the same week it just generated, instead of whatever the
 * default week happens to be.
 */
const jobs = new Map<string, Job>();
let nextId = 1;

export function startJob(work: () => Promise<void>, week?: string): string {
  const id = String(nextId++);
  jobs.set(id, { state: "pending", week });
  work()
    .then(() => jobs.set(id, { state: "done", week }))
    .catch((err) => {
      if (err instanceof NoEntriesError) {
        jobs.set(id, { state: "empty", error: err.message, week });
      } else {
        jobs.set(id, { state: "error", error: err instanceof Error ? err.message : String(err), week });
      }
    });
  return id;
}

export function jobStatus(id: string): Job | null {
  return jobs.get(id) ?? null;
}

export function renderReports(db: Database, weekLabel: string): string {
  const report = latestReport(db, weekLabel);

  const body = report
    ? `<div class="report-meta">v${report.version} · generated ${escapeHtml(report.generated_at)} · template: ${escapeHtml(report.template_source)}</div>
       <article class="report-markdown">${renderMarkdown(report.markdown)}</article>`
    : `<p class="empty">No report for ${escapeHtml(weekLabel)} yet.</p>`;

  return `
    <h1>Weekly Report — ${escapeHtml(weekLabel)}</h1>
    <form hx-post="/reports/generate" hx-vals='{"week": "${escapeHtml(weekLabel)}"}' hx-target="#report-status" hx-swap="innerHTML">
      <button type="submit">Generate</button>
    </form>
    <div id="report-status"></div>
    ${body}
  `;
}

/** Polling fragment returned while a job runs. */
export function renderJobStatus(id: string): string {
  const job = jobStatus(id);
  if (!job) return `<span class="error">Unknown job.</span>`;
  if (job.state === "pending") {
    return `<span hx-get="/reports/status/${id}" hx-trigger="every 2s" hx-swap="outerHTML">Generating… this takes a minute or two.</span>`;
  }
  if (job.state === "error") return `<span class="error">Failed: ${escapeHtml(job.error ?? "unknown")}</span>`;
  if (job.state === "empty") {
    return `<span class="empty">${escapeHtml(job.error ?? "No entries")} — nothing to report.</span>`;
  }
  const target = job.week ? `/reports?week=${encodeURIComponent(job.week)}` : "/reports";
  return `<span hx-get="${target}" hx-trigger="load" hx-target="body">Done — reloading.</span>`;
}
