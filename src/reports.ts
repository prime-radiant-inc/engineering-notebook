/**
 * Weekly report generation.
 *
 * A week's journal entries are rendered into a user-authored prompt template
 * and sent to the model in a single call — the busiest measured week is ~11k
 * characters, so chunking would be premature. The returned markdown is the
 * stored source of truth; the heading parse layered on top is a convenience and
 * is allowed to come back empty.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { complete, providerModel, type SummaryProvider } from "./llm";
import type { WeekRange } from "./week";
import type { ResolvedTemplate } from "./report-template";
import { renderTemplate } from "./report-template";

export type ReportEntry = {
  id: number;
  date: string;
  project_id: string;
  headline: string;
  summary: string;
  topics: string;
  open_questions: string;
};

/** Entries inside the week, skip stubs excluded, oldest first. */
export function gatherEntries(db: Database, range: WeekRange): ReportEntry[] {
  return db
    .query(
      `SELECT id, date, project_id, headline, summary, topics, open_questions
       FROM journal_entries
       WHERE date >= ? AND date <= ? AND headline != ''
       ORDER BY date, project_id`
    )
    .all(range.start, range.end) as ReportEntry[];
}

function parseJsonArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** Placeholder values for the template. Keep in sync with README. */
export function buildVars(range: WeekRange, entries: ReportEntry[]): Record<string, string> {
  const projects = [...new Set(entries.map((e) => e.project_id))];

  const entryBlock = entries
    .map((e) => {
      const topics = parseJsonArray(e.topics);
      const topicLine = topics.length ? `\nTopics: ${topics.join(", ")}` : "";
      return `### ${e.date} — ${e.project_id}\n${e.headline}\n\n${e.summary}${topicLine}`;
    })
    .join("\n\n");

  const questionBlock = entries
    .flatMap((e) => parseJsonArray(e.open_questions).map((q) => `- ${q}  _(${e.date}, ${e.project_id})_`))
    .join("\n");

  return {
    week_label: range.label,
    week_start: range.start,
    week_end: range.end,
    project_list: projects.join(", "),
    entries: entryBlock,
    open_questions: questionBlock || "_none recorded_",
  };
}

/** Best-effort split on level-two headings. Empty result is not an error. */
export function parseSections(markdown: string): Record<string, string> {
  const out: Record<string, string> = {};
  const parts = markdown.split(/^##\s+(.+)$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const heading = parts[i]!.trim();
    const body = (parts[i + 1] ?? "").trim();
    if (heading) out[heading] = body;
  }
  return out;
}

export function storeReport(
  db: Database,
  args: {
    range: WeekRange;
    markdown: string;
    entryIds: number[];
    templateSource: string;
    model: string;
  }
): number {
  const insert = db.transaction(() => {
    const row = db
      .query("SELECT COALESCE(MAX(version), 0) AS v FROM weekly_reports WHERE week_label = ?")
      .get(args.range.label) as { v: number };
    const version = row.v + 1;
    db.query(
      `INSERT INTO weekly_reports
         (week_label, week_start, week_end, version, markdown, sections, entry_ids,
          template_source, model_used, generated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).run(
      args.range.label,
      args.range.start,
      args.range.end,
      version,
      args.markdown,
      JSON.stringify(parseSections(args.markdown)),
      JSON.stringify(args.entryIds),
      args.templateSource,
      args.model
    );
    return version;
  });

  try {
    return insert();
  } catch (err) {
    // A concurrent generation may have taken our version number. Retry once for
    // that specific case only; anything else is a real failure and must surface.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/UNIQUE constraint failed/i.test(msg)) throw err;
    return insert();
  }
}

/**
 * Gather the week's entries and render them into the template.
 *
 * Shared by generateReport and the CLI's --stdout preview so the prompt is
 * built in exactly one place. Throws when the week has no entries.
 */
export function buildPrompt(
  db: Database,
  range: WeekRange,
  template: ResolvedTemplate
): { prompt: string; entries: ReportEntry[] } {
  const entries = gatherEntries(db, range);
  if (entries.length === 0) {
    throw new Error(`No entries for ${range.label} (${range.start} to ${range.end})`);
  }
  return { prompt: renderTemplate(template.text, buildVars(range, entries)), entries };
}

export async function generateReport(
  db: Database,
  opts: {
    range: WeekRange;
    template: ResolvedTemplate;
    provider?: SummaryProvider;
    completeImpl?: typeof complete;
  }
): Promise<{ markdown: string; version: number }> {
  const { prompt, entries } = buildPrompt(db, opts.range, opts.template);
  const run = opts.completeImpl ?? complete;
  const markdown = await run(prompt, opts.provider);

  const version = storeReport(db, {
    range: opts.range,
    markdown,
    entryIds: entries.map((e) => e.id),
    templateSource: opts.template.source,
    model: providerModel(opts.provider),
  });

  return { markdown, version };
}

export type StoredReport = {
  markdown: string;
  version: number;
  generated_at: string;
  template_source: string;
};

/** Latest stored report for a week, or null when none exists. */
export function latestReport(db: Database, weekLabel: string): StoredReport | null {
  const row = db
    .query(
      `SELECT markdown, version, generated_at, template_source
       FROM weekly_reports WHERE week_label = ? ORDER BY version DESC LIMIT 1`
    )
    .get(weekLabel) as StoredReport | null;
  return row ?? null;
}

/** Write the week's markdown to `<dir>/<week_label>.md`, returning the path. */
export function exportMarkdown(dir: string, weekLabel: string, markdown: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${weekLabel}.md`);
  writeFileSync(path, markdown);
  return path;
}
