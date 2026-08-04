import { Database } from "bun:sqlite";
import { escapeHtml } from "./helpers";
import { latestReport } from "../../reports";

export type JobState = "pending" | "done" | "error";
export type Job = { state: JobState; error?: string };

/**
 * In-memory job registry. Generation takes 1-2 minutes, which is too long for a
 * request. A restart loses job *status* but never a report: generateReport
 * commits before the job is marked done, so a lost job just means the user
 * refreshes and finds the report already there.
 */
const jobs = new Map<string, Job>();
let nextId = 1;

export function startJob(work: () => Promise<void>): string {
  const id = String(nextId++);
  jobs.set(id, { state: "pending" });
  work()
    .then(() => jobs.set(id, { state: "done" }))
    .catch((err) => jobs.set(id, { state: "error", error: err instanceof Error ? err.message : String(err) }));
  return id;
}

export function jobStatus(id: string): Job | null {
  return jobs.get(id) ?? null;
}

export function renderReports(db: Database, weekLabel: string): string {
  const report = latestReport(db, weekLabel);

  const body = report
    ? `<div class="report-meta">v${report.version} · generated ${escapeHtml(report.generated_at)} · template: ${escapeHtml(report.template_source)}</div>
       <pre class="report-markdown">${escapeHtml(report.markdown)}</pre>`
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
  return `<span hx-get="/reports" hx-trigger="load" hx-target="body">Done — reloading.</span>`;
}
