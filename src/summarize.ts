import { Database } from "bun:sqlite";

const SUMMARIZE_MODEL = "claude-haiku-4-5-20251001";

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  return await new Response(stream).text();
}

async function getClaudeAuthIssue(): Promise<string | null> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["claude", "auth", "status"], {
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return "Claude Code CLI is not installed or not on PATH. Install Claude Code and run `claude auth login`.";
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    readStream(proc.stdout as ReadableStream<Uint8Array> | null),
    readStream(proc.stderr as ReadableStream<Uint8Array> | null),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    const details = (stderr || stdout).trim();
    if (details) {
      return `Claude auth check failed: ${details}`;
    }
    return "Claude auth check failed. Run `claude auth login` and try again.";
  }

  try {
    const parsed = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string };
    if (parsed.loggedIn === false) {
      return "Claude Code is not logged in. Run `claude auth login` and retry `engineering-notebook summarize --all`.";
    }
  } catch {
    // If format changes, don't block summarize on parse failure.
  }

  return null;
}

function formatSummarizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("Claude Code process exited with code")) {
    return `${msg}. This usually means Claude Code auth/session is unavailable. Run \`claude auth status\` then \`claude auth login\`.`;
  }
  return msg;
}

/** Determine the "logical date" a timestamp belongs to.
 *  Messages before dayStartHour (e.g. 5 AM) count as the previous calendar day,
 *  so late-night sessions are grouped with the day they started on. */
export function logicalDate(timestamp: string, dayStartHour: number): string {
  // timestamp is "YYYY-MM-DD HH:MM" or ISO format
  const normalized = timestamp.replace("T", " ");
  const dateStr = normalized.slice(0, 10);
  const hour = parseInt(normalized.slice(11, 13));
  if (hour < dayStartHour) {
    // Belongs to previous day
    const d = new Date(dateStr + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  return dateStr;
}

export type SessionGroup = {
  date: string;
  projectId: string;
  projectName: string;
  sessionIds: string[];
  conversations: string[];
};

type ConvoRow = {
  session_id: string;
  date: string;
  project_id: string;
  display_name: string;
  conversation_markdown: string;
};

/** Split a conversation markdown into chunks keyed by logical date.
 *  Lines with timestamps in the new format **Speaker (YYYY-MM-DD HH:MM):** are
 *  assigned to their logical date. Non-timestamped lines attach to the most
 *  recent date. If no timestamps are parseable (old format), returns null so
 *  the caller can fall back to the session's started_at date. */
export function splitConversationByDay(
  markdown: string,
  dayStartHour: number
): Map<string, string> | null {
  const byDay = new Map<string, string[]>();
  let currentDay: string | null = null;
  let foundAny = false;

  for (const line of markdown.split("\n")) {
    // Match **Speaker (YYYY-MM-DD HH:MM):**
    const match = line.match(
      /^\*\*\w+\s+\((\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\):\*\*/
    );
    if (match) {
      foundAny = true;
      currentDay = logicalDate(match[1]!, dayStartHour);
      if (!byDay.has(currentDay)) byDay.set(currentDay, []);
      byDay.get(currentDay)!.push(line);
    } else if (currentDay) {
      // Non-message lines (continuation, blank) attach to current day
      byDay.get(currentDay)!.push(line);
    }
    // Lines before the first timestamped message are dropped (headers, etc.)
  }

  if (!foundAny) return null;

  const result = new Map<string, string>();
  for (const [day, lines] of byDay) {
    result.set(day, lines.join("\n"));
  }
  return result;
}

/** Group unsummarized sessions by date and project.
 *  Splits conversations by logical day boundary so a session spanning midnight
 *  contributes messages to the correct date's journal entry. */
export function groupSessionsByDateAndProject(
  db: Database,
  filterDate?: string,
  filterProject?: string,
  dayStartHour: number = 5
): SessionGroup[] {
  // Build a simple WHERE clause — no NOT EXISTS in SQL.
  // We filter out already-summarized (project, date) combos in TypeScript
  // after splitting by logical date, because a single session can now span
  // multiple dates.
  const conditions: string[] = ["s.is_subagent = 0"];
  const params: string[] = [];
  if (filterProject) {
    conditions.push("s.project_id = ?");
    params.push(filterProject);
  }
  const whereClause = "WHERE " + conditions.join(" AND ");

  const rows = db
    .query(
      `
      SELECT
        c.session_id,
        date(s.started_at) as date,
        s.project_id,
        p.display_name,
        c.conversation_markdown
      FROM conversations c
      JOIN sessions s ON c.session_id = s.id
      JOIN projects p ON s.project_id = p.id
      ${whereClause}
      ORDER BY s.started_at
    `
    )
    .all(...params) as ConvoRow[];

  // Build set of already-summarized (project, date) combos
  const summarizedRows = db
    .query(`SELECT project_id, date FROM journal_entries`)
    .all() as { project_id: string; date: string }[];
  const summarized = new Set(
    summarizedRows.map((r) => `${r.date}|${r.project_id}`)
  );

  // Group by (logical-date, project)
  const groups = new Map<string, SessionGroup>();

  for (const row of rows) {
    const dayChunks = splitConversationByDay(
      row.conversation_markdown,
      dayStartHour
    );

    if (dayChunks) {
      // New-format timestamps: split across logical dates
      for (const [day, chunk] of dayChunks) {
        const key = `${day}|${row.project_id}`;
        if (!groups.has(key)) {
          groups.set(key, {
            date: day,
            projectId: row.project_id,
            projectName: row.display_name,
            sessionIds: [],
            conversations: [],
          });
        }
        const group = groups.get(key)!;
        if (!group.sessionIds.includes(row.session_id)) {
          group.sessionIds.push(row.session_id);
        }
        group.conversations.push(chunk);
      }
    } else {
      // Old-format timestamps: fall back to session's started_at date
      const fallbackDay = logicalDate(
        row.date + " 12:00",
        dayStartHour
      );
      const key = `${fallbackDay}|${row.project_id}`;
      if (!groups.has(key)) {
        groups.set(key, {
          date: fallbackDay,
          projectId: row.project_id,
          projectName: row.display_name,
          sessionIds: [],
          conversations: [],
        });
      }
      const group = groups.get(key)!;
      if (!group.sessionIds.includes(row.session_id)) {
        group.sessionIds.push(row.session_id);
      }
      group.conversations.push(row.conversation_markdown);
    }
  }

  // Filter out already-summarized combos
  const result: SessionGroup[] = [];
  for (const group of groups.values()) {
    const key = `${group.date}|${group.projectId}`;
    if (!summarized.has(key)) {
      // Apply filterDate check against logical date
      if (!filterDate || group.date === filterDate) {
        result.push(group);
      }
    }
  }

  return result;
}

/** Build the prompt for LLM summarization */
export function buildSummaryPrompt(group: SessionGroup): string {
  const conversationText = group.conversations.join("\n\n---\n\n");
  return `You are writing an engineering journal entry. The reader uses Claude Code heavily across many projects and needs a quick way to remember what they worked on each day.

Focus on: what problems were being solved, what got shipped, what broke, and any threads that got dropped. Write from the developer's first-person perspective. Keep it high-level — business value and outcomes, not implementation details.

Here are two examples of excellent entries:

EXAMPLE 1:
HEADLINE: Shipped user onboarding flow and fixed production auth bug
SUMMARY: Spent the morning building out the new user onboarding wizard — got the multi-step form working with proper validation and hooked it up to the API. Shipped it to staging by lunch. After that, got pulled into a production issue where OAuth tokens were silently expiring for Google SSO users. Tracked it down to a clock skew problem in token validation, patched it, and deployed the fix. Still need to circle back to adding the email verification step to onboarding — ran out of time.
TOPICS: ["onboarding flow", "OAuth token bug", "production hotfix", "email verification (dropped)"]
OPEN_QUESTIONS: ["Add email verification step to onboarding", "Monitor OAuth token refresh error rates after fix"]

EXAMPLE 2:
HEADLINE: Explored caching strategies, abandoned Redis approach
SUMMARY: Started the day trying to add Redis caching to speed up the dashboard queries. Got it working locally but realized the invalidation logic would be a nightmare with our event-sourced data model. Pivoted to a simpler approach using SQLite materialized views that refresh on write. The dashboard loads are 10x faster now without the operational complexity. Also helped debug a teammate's CI failure that turned out to be a flaky test.
TOPICS: ["caching optimization", "Redis (abandoned)", "SQLite materialized views", "CI debugging"]
OPEN_QUESTIONS: ["Run load test on materialized view refresh under write-heavy workload"]

Now write an entry for ${group.date}, project "${group.projectName}".

IMPORTANT: Some transcripts may be truncated or contain "[...]" placeholders where content was cut. Work with whatever is available — write the best summary you can from the visible content. Never refuse or ask for more data. If you can only see fragments, summarize those fragments.

If the transcripts show NO substantive engineering work — for example, automated test runs, single-shot bot queries, CI/CD routing decisions, or trivial one-line interchanges with no problem-solving — respond with ONLY:

SKIP: <brief reason why this isn't journal-worthy>

Do NOT skip a session just because the transcript is short or appears to be a thin slice of a longer conversation. If real work was discussed — planning, debugging, designing, building — it's journal-worthy even if the transcript only covers the start or end of the effort.

Otherwise, format your response EXACTLY as:

HEADLINE: <one line, what happened today on this project>
SUMMARY: <one paragraph, 2-5 sentences — wins, failures, and dropped threads>
TOPICS: <JSON array of 3-8 short topic phrases>
OPEN_QUESTIONS: <JSON array of 0-5 short phrases — unresolved issues, deferred decisions, dropped threads, open questions. Empty array [] if nothing was left unresolved.>

Here are the session transcripts:

${conversationText}`;
}

type SummaryResult =
  | { skipped: true; skipReason: string }
  | { skipped: false; headline: string; summary: string; topics: string[]; openQuestions: string[] };

/** Parse the LLM response into structured fields */
export function parseSummaryResponse(response: string): SummaryResult {
  const trimmed = response.trim();
  const skipMatch = trimmed.match(/^SKIP:\s*(.+)/);
  if (skipMatch) {
    return { skipped: true, skipReason: skipMatch[1]!.trim() };
  }

  const headlineMatch = response.match(
    /HEADLINE:\s*(.*?)(?:\n|$)/
  );
  const summaryMatch = response.match(
    /SUMMARY:\s*([\s\S]*?)(?=\nTOPICS:)/
  );
  const topicsSection = response.match(
    /TOPICS:\s*([\s\S]*?)(?=\nOPEN_QUESTIONS:|$)/
  );
  const openQuestionsSection = response.match(
    /OPEN_QUESTIONS:\s*([\s\S]*?)$/
  );

  const headline = headlineMatch ? headlineMatch[1]!.trim() : "";
  const summary = summaryMatch ? summaryMatch[1]!.trim() : response.trim();

  let topics: string[] = [];
  if (topicsSection) {
    try {
      topics = JSON.parse(topicsSection[1]!.trim());
    } catch {
      topics = [];
    }
  }

  let openQuestions: string[] = [];
  if (openQuestionsSection) {
    try {
      openQuestions = JSON.parse(openQuestionsSection[1]!.trim());
    } catch {
      openQuestions = [];
    }
  }

  return { skipped: false, headline, summary, topics, openQuestions };
}

/** Run LLM summarization using Claude Agent SDK */
export async function summarizeGroup(
  group: SessionGroup,
  db: Database
): Promise<{ skipped: boolean; skipReason?: string }> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const prompt = buildSummaryPrompt(group);

  let responseText = "";

  const env = { ...process.env };
  delete env.CLAUDECODE;

  const result = query({
    prompt,
    options: {
      model: SUMMARIZE_MODEL,
      maxTurns: 1,
      tools: [],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      persistSession: false,
      env,
    },
  });

  for await (const message of result) {
    if (message.type === "assistant") {
      const content = message.message.content;
      for (const block of content) {
        if ("text" in block && typeof block.text === "string") {
          responseText += block.text;
        }
      }
    }
  }

  if (!responseText.trim()) {
    throw new Error("Empty response from LLM");
  }

  const parsed = parseSummaryResponse(responseText);

  if (parsed.skipped) {
    return { skipped: true, skipReason: parsed.skipReason };
  }

  db.prepare(
    `
    INSERT INTO journal_entries (date, project_id, session_ids, headline, summary, topics, open_questions, generated_at, model_used)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
    ON CONFLICT(date, project_id) DO UPDATE SET
      headline = excluded.headline,
      summary = excluded.summary,
      topics = excluded.topics,
      open_questions = excluded.open_questions,
      generated_at = excluded.generated_at,
      session_ids = excluded.session_ids
  `
  ).run(
    group.date,
    group.projectId,
    JSON.stringify(group.sessionIds),
    parsed.headline,
    parsed.summary,
    JSON.stringify(parsed.topics),
    JSON.stringify(parsed.openQuestions),
    SUMMARIZE_MODEL
  );

  return { skipped: false };
}

/** Summarize all unsummarized groups */
export async function summarizeAll(
  db: Database,
  filterDate?: string,
  filterProject?: string,
  onProgress?: (done: number, total: number, group: SessionGroup) => void,
  dayStartHour: number = 5
): Promise<{ summarized: number; skipped: number; skipReasons: string[]; errors: string[] }> {
  const groups = groupSessionsByDateAndProject(db, filterDate, filterProject, dayStartHour);
  let summarized = 0;
  let skipped = 0;
  const skipReasons: string[] = [];
  const errors: string[] = [];

  if (groups.length > 0) {
    const authIssue = await getClaudeAuthIssue();
    if (authIssue) {
      errors.push(authIssue);
      return { summarized, skipped, skipReasons, errors };
    }
  }

  for (const group of groups) {
    try {
      onProgress?.(summarized + skipped, groups.length, group);
      const result = await summarizeGroup(group, db);
      if (result.skipped) {
        skipped++;
        if (result.skipReason) skipReasons.push(result.skipReason);
      } else {
        summarized++;
      }
    } catch (err) {
      errors.push(`${group.date}/${group.projectId}: ${formatSummarizeError(err)}`);
    }
  }

  return { summarized, skipped, skipReasons, errors };
}
