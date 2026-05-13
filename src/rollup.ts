import { Database } from "bun:sqlite";
import type { Config } from "./config";
import {
  resolveSummarizerSettings,
  parseSummaryResponse,
  summarizeWithClaude,
  summarizeWithOpenAICompat,
  CLAUDE_SUMMARIZE_MODEL,
  type SummaryResult,
} from "./summarize";

type SummarizerConfig = Pick<
  Config,
  | "summary_provider"
  | "summary_base_url"
  | "summary_model"
  | "summary_extras"
  | "summary_instructions"
>;

/** Get the Monday of the ISO week containing the given YYYY-MM-DD date.
 *  Returns a YYYY-MM-DD string. ISO weeks start on Monday. */
export function weekStart(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  const dayOfWeek = d.getUTCDay(); // 0 = Sunday, 1 = Monday, ...
  const daysFromMonday = (dayOfWeek + 6) % 7;
  d.setUTCDate(d.getUTCDate() - daysFromMonday);
  return d.toISOString().slice(0, 10);
}

/** Format a week's display range, e.g. "May 13 – May 19, 2026". */
export function formatWeekRange(weekMonday: string): string {
  const start = new Date(weekMonday + "T12:00:00Z");
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  const sameMonth = start.getUTCMonth() === end.getUTCMonth();
  const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
  const startLabel = start.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  const endLabel = end.toLocaleDateString("en-US", {
    month: sameMonth ? undefined : "short",
    day: "numeric",
    year: sameYear ? "numeric" : undefined,
    timeZone: "UTC",
  });
  return sameYear
    ? `${startLabel} – ${endLabel}, ${end.getUTCFullYear()}`
    : `${startLabel}, ${start.getUTCFullYear()} – ${endLabel}`;
}

type DailyEntry = {
  date: string;
  headline: string;
  summary: string;
  topics: string[];
  openQuestions: string[];
  isSkip: boolean;
};

/** Fetch all daily entries for a (project, week) tuple. */
export function getDailyEntriesForWeek(
  db: Database,
  projectId: string,
  weekMonday: string
): DailyEntry[] {
  const rows = db
    .query<
      {
        date: string;
        headline: string;
        summary: string;
        topics: string;
        open_questions: string;
      },
      [string, string, string]
    >(
      `
      SELECT date, headline, summary, topics, open_questions
      FROM journal_entries
      WHERE project_id = ? AND date >= ? AND date < date(?, '+7 days')
      ORDER BY date
      `
    )
    .all(projectId, weekMonday, weekMonday);

  return rows.map((r) => {
    let topics: string[] = [];
    let openQuestions: string[] = [];
    try {
      topics = JSON.parse(r.topics);
    } catch {
      // ignore
    }
    try {
      openQuestions = JSON.parse(r.open_questions);
    } catch {
      // ignore
    }
    return {
      date: r.date,
      headline: r.headline,
      summary: r.summary,
      topics,
      openQuestions,
      isSkip: r.headline === "",
    };
  });
}

/** Build the prompt for weekly per-project rollup. */
export function buildWeeklyRollupPrompt(
  projectName: string,
  weekMonday: string,
  entries: DailyEntry[],
  summaryInstructions?: string
): string {
  const weekRange = formatWeekRange(weekMonday);
  const custom = summaryInstructions?.trim()
    ? `\n\nAdditional instructions from the user:\n${summaryInstructions.trim()}\n`
    : "";

  const realEntries = entries.filter((e) => !e.isSkip);
  const skipEntries = entries.filter((e) => e.isSkip);

  const dailyBlock = realEntries
    .map(
      (e) =>
        `### ${e.date}\nHEADLINE: ${e.headline}\nSUMMARY: ${e.summary}\nTOPICS: ${JSON.stringify(e.topics)}\nOPEN_QUESTIONS: ${JSON.stringify(e.openQuestions)}`
    )
    .join("\n\n");

  const skipBlock = skipEntries.length
    ? `\n\nThe following days had no journal entry (skipped at the daily level):\n${skipEntries.map((e) => `- ${e.date}: ${e.summary}`).join("\n")}`
    : "";

  return `You are writing a weekly engineering retrospective for the developer.

Project: ${projectName}
Week: ${weekRange} (${weekMonday} through ${addDaysISO(weekMonday, 6)})

Below are the daily journal entries for this project across the week. Synthesize them into a single weekly narrative: what was accomplished, what was being figured out, what's still open, and what dropped. Focus on through-lines that span multiple days. Don't just concatenate — group related work, name the larger arcs.

If multiple days converged on a single goal (e.g., "spent Monday debugging X, Tuesday refactoring around it, Wednesday shipped the fix"), say so as one narrative beat rather than three.

${dailyBlock}${skipBlock}

If the week shows NO substantive engineering work — only status checks, automated runs, or trivial interchanges — respond with ONLY:

SKIP: <brief reason>

Otherwise, format your response EXACTLY as:

HEADLINE: <one line, the main story of the week on this project>
SUMMARY: <2-4 sentences — wins, failures, and through-lines>
TOPICS: <JSON array of 4-10 short topic phrases — themes that recurred across the week>
OPEN_QUESTIONS: <JSON array of 0-6 short phrases — unresolved threads still open at week end. Dedupe across days. Drop questions that were resolved later in the week. Empty array [] if nothing's left open.>${custom}`;
}

function addDaysISO(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export type RollupResult =
  | { skipped: true; skipReason: string }
  | {
      skipped: false;
      headline: string;
      summary: string;
      topics: string[];
      openQuestions: string[];
    };

/** Generate a weekly rollup for a single (project, week) tuple and upsert it
 *  into the journal_rollups table. Returns the parsed result. */
export async function rollupWeek(
  db: Database,
  projectId: string,
  weekMonday: string,
  config?: Partial<SummarizerConfig>
): Promise<RollupResult> {
  const project = db
    .query<{ display_name: string }, [string]>(
      "SELECT display_name FROM projects WHERE id = ?"
    )
    .get(projectId);
  if (!project) {
    throw new Error(`Project ${projectId} not found.`);
  }

  const entries = getDailyEntriesForWeek(db, projectId, weekMonday);
  if (entries.length === 0) {
    throw new Error(
      `No daily entries found for project ${projectId} in week starting ${weekMonday}.`
    );
  }

  const realEntries = entries.filter((e) => !e.isSkip);
  if (realEntries.length === 0) {
    const result: RollupResult = {
      skipped: true,
      skipReason: "All daily entries in this week were skipped.",
    };
    upsertRollup(db, "week", weekMonday, projectId, entries, [], result, "n/a");
    return result;
  }

  const settings = resolveSummarizerSettings(config);
  const modelUsed =
    settings.provider === "openai-compat" ? settings.model : CLAUDE_SUMMARIZE_MODEL;
  const prompt = buildWeeklyRollupPrompt(
    project.display_name,
    weekMonday,
    entries,
    config?.summary_instructions
  );

  const rawResponse =
    settings.provider === "openai-compat"
      ? await summarizeWithOpenAICompat(prompt, settings)
      : await summarizeWithClaude(prompt);

  if (!rawResponse.trim()) {
    throw new Error("Empty response from LLM during weekly rollup.");
  }

  const parsed = parseSummaryResponse(rawResponse);
  const result: RollupResult = parsed.skipped
    ? { skipped: true, skipReason: parsed.skipReason }
    : {
        skipped: false,
        headline: parsed.headline,
        summary: parsed.summary,
        topics: parsed.topics,
        openQuestions: parsed.openQuestions,
      };

  upsertRollup(db, "week", weekMonday, projectId, entries, [], result, modelUsed);
  return result;
}

/** Persist a rollup result. */
function upsertRollup(
  db: Database,
  period: string,
  periodStart: string,
  projectId: string,
  entries: DailyEntry[],
  reauditedDates: string[],
  result: RollupResult,
  modelUsed: string
): void {
  const sourcesCount = entries.length;
  if (result.skipped) {
    db.prepare(
      `
      INSERT INTO journal_rollups
        (period, period_start, project_id, headline, summary, topics, open_questions, sources_count, reaudited_dates, generated_at, model_used)
      VALUES (?, ?, ?, '', ?, '[]', '[]', ?, ?, datetime('now'), ?)
      ON CONFLICT(period, period_start, project_id) DO UPDATE SET
        headline = '',
        summary = excluded.summary,
        topics = '[]',
        open_questions = '[]',
        sources_count = excluded.sources_count,
        reaudited_dates = excluded.reaudited_dates,
        generated_at = excluded.generated_at,
        model_used = excluded.model_used
      `
    ).run(
      period,
      periodStart,
      projectId,
      result.skipReason,
      sourcesCount,
      JSON.stringify(reauditedDates),
      modelUsed
    );
    return;
  }

  db.prepare(
    `
    INSERT INTO journal_rollups
      (period, period_start, project_id, headline, summary, topics, open_questions, sources_count, reaudited_dates, generated_at, model_used)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
    ON CONFLICT(period, period_start, project_id) DO UPDATE SET
      headline = excluded.headline,
      summary = excluded.summary,
      topics = excluded.topics,
      open_questions = excluded.open_questions,
      sources_count = excluded.sources_count,
      reaudited_dates = excluded.reaudited_dates,
      generated_at = excluded.generated_at,
      model_used = excluded.model_used
    `
  ).run(
    period,
    periodStart,
    projectId,
    result.headline,
    result.summary,
    JSON.stringify(result.topics),
    JSON.stringify(result.openQuestions),
    sourcesCount,
    JSON.stringify(reauditedDates),
    modelUsed
  );
}

/** Find all (week, project) tuples that have at least one daily entry but no
 *  rollup yet. Used by the CLI to drive batch rollup generation. */
export function findUnrolledWeeks(
  db: Database
): Array<{ weekMonday: string; projectId: string; projectName: string; entryCount: number }> {
  const rows = db
    .query<
      { date: string; project_id: string; display_name: string },
      []
    >(
      `
      SELECT j.date, j.project_id, p.display_name
      FROM journal_entries j
      JOIN projects p ON j.project_id = p.id
      `
    )
    .all();

  // Group by (weekMonday, projectId)
  const groups = new Map<string, { weekMonday: string; projectId: string; projectName: string; entryCount: number }>();
  for (const row of rows) {
    const monday = weekStart(row.date);
    const key = `${monday}|${row.project_id}`;
    const existing = groups.get(key);
    if (existing) {
      existing.entryCount++;
    } else {
      groups.set(key, {
        weekMonday: monday,
        projectId: row.project_id,
        projectName: row.display_name,
        entryCount: 1,
      });
    }
  }

  // Filter out tuples that already have a rollup
  const rolled = new Set(
    db
      .query<{ period_start: string; project_id: string }, []>(
        "SELECT period_start, project_id FROM journal_rollups WHERE period = 'week' AND project_id != ''"
      )
      .all()
      .map((r) => `${r.period_start}|${r.project_id}`)
  );

  return [...groups.values()]
    .filter((g) => !rolled.has(`${g.weekMonday}|${g.projectId}`))
    .sort((a, b) =>
      a.weekMonday === b.weekMonday
        ? a.projectName.localeCompare(b.projectName)
        : a.weekMonday.localeCompare(b.weekMonday)
    );
}
