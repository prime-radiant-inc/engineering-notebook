/** RLM-style recursive orchestrator for transcripts that exceed the
 *  one-shot context budget.
 *
 *  This is the >800K fallback for `summarize-one-shot`'s fast path. It
 *  treats the transcript as a delegated workspace and lets the model
 *  inspect it through three tools:
 *
 *    search(query)              — find offsets within the current scope
 *    read_range(start, end)     — read up to READ_WINDOW chars (counts as covered)
 *    spawn(start, end, question) — recursively delegate a strict sub-range
 *                                  to a child invocation (counts as covered)
 *
 *  Hard invariants the orchestrator enforces:
 *
 *  1. Sandboxed scopes: each invocation sees only its delegated slice.
 *     Children CANNOT expand beyond their delegated range.
 *
 *  2. Spawn shrinkage: child range must be a proper subset of parent's,
 *     nonzero width, AND at most 50% of the parent's length (forces real
 *     divide-and-conquer, prevents trivial-shrink recursion).
 *
 *  3. Spawn forbidden at leaf scopes (≤ READ_WINDOW). Leaves auto-read
 *     their full content in one call. This is the natural termination
 *     guarantee — recursion bottoms out at leaves of size ≤ READ_WINDOW.
 *
 *  4. Mandatory complete coverage: every invocation MUST cover 100% of
 *     its scope before `done` is honored. Coverage = union of read_range
 *     spans + spawn ranges.
 *
 *  5. Coherence-token canary: each invocation generates a per-invocation
 *     random token; model must echo it on `done`. Catches cases where the
 *     model produces a `done` from training rather than from this loop.
 *
 *  Empirical findings:
 *    - Each plan call is significantly cheaper with `think: false`
 *      (1-5s instead of 20-60s) and the schema for plans is small enough
 *      that schema enforcement holds reliably.
 *    - For 480KB+ transcripts, expect ~15-30 minutes total wall clock,
 *      with depth ~6-8 levels.
 */

import type { Config } from "./config";
import {
  resolveSummarizerSettings,
  summarizeWithClaude,
  summarizeWithOpenAICompat,
  CLAUDE_SUMMARIZE_MODEL,
  type SummaryResult,
  type ResolvedSummarizerSettings,
} from "./summarize";

type SummarizerConfig = Pick<
  Config,
  | "summary_provider"
  | "summary_base_url"
  | "summary_model"
  | "summary_extras"
  | "summary_instructions"
>;

const READ_WINDOW = 2000;
const MAX_ACTIONS_PER_INVOCATION = 20;

// ─────────────────────────────────────────────────────────────
// Scope, span, and coverage primitives — pure, deterministic
// ─────────────────────────────────────────────────────────────

export type Scope = {
  /** Char offset in the source transcript where this scope begins. */
  globalStart: number;
  /** Char offset where this scope ends (exclusive). */
  globalEnd: number;
  /** Human-readable label for logging (e.g. "root/[10000-20000]"). */
  label: string;
};

export type Span = [start: number, end: number];

export function scopedLength(scope: Scope): number {
  return scope.globalEnd - scope.globalStart;
}

/** Merge a list of spans into non-overlapping intervals. Returns merged
 *  intervals and total chars covered. */
export function mergeSpans(spans: Span[]): {
  merged: Span[];
  covered: number;
} {
  if (spans.length === 0) return { merged: [], covered: 0 };
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const merged: Span[] = [[sorted[0]![0], sorted[0]![1]]];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const last = merged[merged.length - 1]!;
    if (cur[0] <= last[1]) {
      last[1] = Math.max(last[1], cur[1]);
    } else {
      merged.push([cur[0], cur[1]]);
    }
  }
  const covered = merged.reduce((sum, [s, e]) => sum + (e - s), 0);
  return { merged, covered };
}

/** Compute uncovered intervals within [0, scopeLen) given covered spans. */
export function residualGaps(scopeLen: number, covered: Span[]): Span[] {
  const { merged } = mergeSpans(covered);
  const gaps: Span[] = [];
  let cursor = 0;
  for (const [s, e] of merged) {
    if (s > cursor) gaps.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < scopeLen) gaps.push([cursor, scopeLen]);
  return gaps;
}

/** Validate a proposed spawn range against parent scope. Returns null if OK
 *  or an error string explaining why it's rejected. The rules:
 *    - in bounds: 0 ≤ start, end ≤ scopeLen
 *    - nonzero: end > start
 *    - meaningful shrinkage: child length ≤ 50% of parent
 *      (this also implies it's a proper subset). */
export function validateSpawnRange(
  scopeLen: number,
  subStart: number,
  subEnd: number
): string | null {
  if (subStart < 0 || subEnd > scopeLen) return "out of scope";
  if (subEnd <= subStart) return "empty range";
  const subLen = subEnd - subStart;
  const halfParent = Math.floor(scopeLen / 2);
  if (subLen > halfParent) {
    return `child must be ≤50% of parent (got ${subLen}/${scopeLen} = ${((subLen / scopeLen) * 100).toFixed(0)}%)`;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// Tools (operate within a scope, with a transcript provided)
// ─────────────────────────────────────────────────────────────

type SearchHit = { offset: number; preview: string };

function tool_search(
  transcript: string,
  scope: Scope,
  query: string
): SearchHit[] {
  if (!query.trim()) return [];
  const text = transcript.slice(scope.globalStart, scope.globalEnd);
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const hits: SearchHit[] = [];
  let from = 0;
  while (hits.length < 10) {
    const idx = lowerText.indexOf(lowerQuery, from);
    if (idx === -1) break;
    const previewStart = Math.max(0, idx - 60);
    const previewEnd = Math.min(text.length, idx + query.length + 60);
    hits.push({
      offset: idx,
      preview: text.slice(previewStart, previewEnd).replace(/\n/g, " ⏎ "),
    });
    from = idx + 1;
  }
  return hits;
}

function tool_read_range(
  transcript: string,
  scope: Scope,
  start: number,
  end: number
): string {
  const text = transcript.slice(scope.globalStart, scope.globalEnd);
  const s = Math.max(0, Math.min(text.length, start));
  const e = Math.max(s, Math.min(text.length, end, s + READ_WINDOW));
  return text.slice(s, e);
}

// ─────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    reasoning: { type: "string" },
    action: {
      type: "string",
      enum: ["search", "read_range", "spawn", "done"],
    },
    query: { type: ["string", "null"] },
    start: { type: ["integer", "null"] },
    end: { type: ["integer", "null"] },
    sub_question: { type: ["string", "null"] },
    coherence_token: { type: ["string", "null"] },
  },
  required: ["reasoning", "action"],
} as const;

const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    skipped: { type: "boolean" },
    skip_reason: { type: ["string", "null"] },
    headline: { type: "string" },
    summary: { type: "string" },
    topics: { type: "array", items: { type: "string" } },
    open_questions: { type: "array", items: { type: "string" } },
  },
  required: ["skipped", "headline", "summary", "topics", "open_questions"],
} as const;

// ─────────────────────────────────────────────────────────────
// LLM call dispatch — routes through the configured provider
// ─────────────────────────────────────────────────────────────

type LlmStats = {
  elapsedMs: number;
  promptChars: number;
};

/** Call the configured provider with a JSON-only prompt. Both providers
 *  share the same parse semantics: the LLM is asked to reply with JSON
 *  matching the schema, and we attempt JSON.parse on the raw content.
 *
 *  The schema parameter is used only for openai-compat providers that
 *  honor `format` / `response_format`. The Claude provider doesn't have a
 *  format parameter, so the schema is enforced purely via prompt text. */
async function callLlm(
  prompt: string,
  schema: object,
  settings: ResolvedSummarizerSettings
): Promise<{ parsed: Record<string, unknown>; stats: LlmStats }> {
  const t0 = Date.now();
  let rawContent: string;

  if (settings.provider === "claude") {
    rawContent = await summarizeWithClaude(prompt);
  } else {
    rawContent = await summarizeWithOpenAICompat(prompt, settings);
  }

  const stats: LlmStats = {
    elapsedMs: Date.now() - t0,
    promptChars: prompt.length,
  };

  if (!rawContent.trim()) {
    throw new Error("Empty content from LLM");
  }
  const parsed = parseLlmJsonResponse(rawContent);
  if (parsed === null) {
    throw new Error(`Non-JSON content: ${rawContent.slice(0, 200)}`);
  }
  return { parsed, stats };
}

/** Extract a JSON object from an LLM response that may contain extraneous
 *  framing. Recovery strategies, in order of preference:
 *
 *  1. Direct parse (the happy path).
 *  2. Strip markdown code fences (```json ... ```).
 *  3. Strip <think>...</think> blocks (some providers leak reasoning into
 *     content even when thinking should be off).
 *  4. Find the first balanced {...} substring and parse that. Handles
 *     responses with prose preamble or trailing commentary.
 *
 *  Returns the parsed object or null if no recovery succeeds. */
export function parseLlmJsonResponse(
  raw: string
): Record<string, unknown> | null {
  const candidates: string[] = [];

  // Strategy 1: try the raw content directly.
  candidates.push(raw.trim());

  // Strategy 2: strip ``` fences.
  const fenced = raw
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "");
  if (fenced !== raw.trim()) candidates.push(fenced);

  // Strategy 3: strip <think>...</think> blocks (greedy + non-greedy).
  // Some providers (notably Ollama with certain models) emit thinking
  // tokens inline in content even when think:false is set.
  const dethought = raw
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<\/think>/g, "")
    .trim();
  if (dethought !== raw.trim()) candidates.push(dethought);

  // Strategy 4: find the first balanced JSON object substring.
  // Scans for the first `{` and tracks brace depth (respecting strings)
  // until it reaches matching depth 0. This recovers from prose preamble
  // and trailing text.
  const balanced = extractFirstBalancedObject(raw);
  if (balanced !== null) candidates.push(balanced);

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        return obj as Record<string, unknown>;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

/** Find the first balanced `{...}` JSON object substring in text. Returns
 *  the substring (including braces) or null if none found. Respects string
 *  literals (escaped quotes inside strings don't affect depth). */
export function extractFirstBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function makeCoherenceToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ─────────────────────────────────────────────────────────────
// Recursive invocation
// ─────────────────────────────────────────────────────────────

export type RecursiveResult = {
  parsed: SummaryResult;
  modelUsed: string;
  /** Spans this invocation covered, in scope-relative coords. */
  coveredSpans: Span[];
  scope: Scope;
  /** Total invocations (including children). */
  totalInvocations: number;
};

type ObservationEntry = {
  step: number;
  action: string;
  detail: string;
  result: string;
};

function buildPlanPrompt(
  projectName: string,
  date: string,
  scope: Scope,
  question: string,
  observations: ObservationEntry[],
  budget: number,
  depth: number,
  coherenceToken: string,
  coveredSpans: Span[],
  totalInvocationsRemaining: number
): string {
  const obs =
    observations.length === 0
      ? "(no observations yet)"
      : observations
          .map(
            (o) =>
              `Step ${o.step}: ${o.action}(${o.detail})\nResult: ${o.result}`
          )
          .join("\n\n---\n\n");

  const scopeLen = scopedLength(scope);
  const { covered } = mergeSpans(coveredSpans);
  const gaps = residualGaps(scopeLen, coveredSpans);
  const coveragePct = scopeLen === 0 ? 100 : (covered / scopeLen) * 100;
  const isFullyCovered = covered >= scopeLen;
  const canSpawn = scopeLen > READ_WINDOW;

  const coverageBlock = isFullyCovered
    ? `Coverage: ${covered}/${scopeLen} chars (${coveragePct.toFixed(1)}%) — FULLY COVERED. done is now valid.`
    : `Coverage: ${covered}/${scopeLen} chars (${coveragePct.toFixed(1)}%).
Uncovered ranges (you MUST cover all before done):
${gaps.map(([s, e]) => `  [${s}, ${e}) — ${e - s} chars`).join("\n")}`;

  return `You are inspecting a slice of an engineering session transcript at depth ${depth}. You can ONLY see content within your delegated scope (${scopeLen} chars). You CANNOT expand outside this slice.

PROJECT: ${projectName}
DATE: ${date}
QUESTION: ${question}

YOUR SCOPE: ${scope.label} — ${scopeLen} characters. Offsets in tools are RELATIVE to this scope (0 = start of slice).

YOUR COHERENCE TOKEN: ${coherenceToken}
You MUST echo this exact token in coherence_token when you call done.

${coverageBlock}

Available actions (pick ONE per step, JSON only):
- search(query): up to 10 hits within your slice. action="search", fill query. (does NOT count toward coverage.)
- read_range(start, end): up to ${READ_WINDOW} chars from your slice. action="read_range", fill start/end. (counts toward coverage.)
${canSpawn ? `- spawn(start, end, sub_question): delegate a sub-range to a child inspector. The child sees ONLY [start, end] and must itself cover 100%. Sub-range must be at most ${Math.floor(scopeLen / 2)} chars (≤50% of your scope). action="spawn", fill start/end/sub_question. (counts toward coverage.)` : `- spawn FORBIDDEN at this scope size (≤${READ_WINDOW} chars). Read directly.`}
- done: terminate. Allowed ONLY when coverage is 100%. action="done", fill coherence_token verbatim from above.

Constraints:
- ${budget} actions remaining for this invocation.
- ${totalInvocationsRemaining} invocations remaining in the global tree budget.
- Reply ONLY with JSON matching the schema. No prose outside it.
- Coverage must reach 100% before done is honored.

Past observations:
${obs}

Pick your next action.`;
}

function buildExtractPrompt(
  projectName: string,
  date: string,
  scope: Scope,
  question: string,
  observations: ObservationEntry[],
  summaryInstructions?: string
): string {
  const customInstructions = summaryInstructions?.trim()
    ? `\n\nAdditional instructions from the user:\n${summaryInstructions.trim()}`
    : "";
  const obs = observations
    .map((o) => `### ${o.action}(${o.detail})\n${o.result}`)
    .join("\n\n");

  const isLeaf = observations.length === 1 && observations[0]!.action === "auto_read";

  const baseTask = isLeaf
    ? `Compose a structured summary of the engineering work in the transcript chunk below for project "${projectName}" on ${date}.`
    : `Compose a structured summary answering "${question}" by combining the snippets and child summaries below from your slice (${scope.label}, ${scopedLength(scope)} chars).`;

  return `${baseTask}

Reply ONLY with JSON matching the schema. ALL of the following fields MUST be present:
- skipped (boolean): true only if no substantive engineering work appears
- skip_reason (string or null): brief reason if skipped, otherwise null
- headline (string): one line summary
- summary (string): 2-5 sentences in first-person developer voice
- topics (array of 3-8 short strings)
- open_questions (array of 0-5 short strings)

Inputs:
${obs}${customInstructions}`;
}

function parseExtractResponse(parsed: Record<string, unknown>): SummaryResult {
  if (parsed.skipped === true) {
    const reason =
      typeof parsed.skip_reason === "string"
        ? parsed.skip_reason
        : "no reason given";
    return { skipped: true, skipReason: reason };
  }
  return {
    skipped: false,
    headline: typeof parsed.headline === "string" ? parsed.headline : "",
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    topics: Array.isArray(parsed.topics)
      ? (parsed.topics.filter((t) => typeof t === "string") as string[])
      : [],
    openQuestions: Array.isArray(parsed.open_questions)
      ? (parsed.open_questions.filter((q) => typeof q === "string") as string[])
      : [],
  };
}

/** Internal recursive driver. Returns when this invocation has produced an
 *  extract or hit an error. Maintains a shared invocation counter via the
 *  `state` object so the global cap is honored across the tree. */
async function invokeRecursive(
  transcript: string,
  projectName: string,
  date: string,
  scope: Scope,
  question: string,
  config: Partial<SummarizerConfig> | undefined,
  depth: number,
  state: { totalInvocations: number; maxInvocations: number },
  summaryInstructions: string | undefined,
  onProgress?: (msg: string) => void
): Promise<{
  result: SummaryResult;
  coveredSpans: Span[];
  modelUsed: string;
}> {
  state.totalInvocations++;
  const settings = resolveSummarizerSettings(config);
  const indent = "  ".repeat(depth);
  const coherenceToken = makeCoherenceToken();
  const observations: ObservationEntry[] = [];
  const coveredSpans: Span[] = [];
  const scopeLen = scopedLength(scope);

  onProgress?.(
    `${indent}#${state.totalInvocations} d=${depth} scope=${scope.label} (${scopeLen}c) token=${coherenceToken}`
  );

  // Leaf invocation: auto-read entire scope, skip the planning loop.
  if (scopeLen <= READ_WINDOW) {
    const text = tool_read_range(transcript, scope, 0, scopeLen);
    coveredSpans.push([0, scopeLen]);
    observations.push({
      step: 0,
      action: "auto_read",
      detail: `0, ${scopeLen}`,
      result: text,
    });
    onProgress?.(`${indent}  leaf: auto-read ${scopeLen}c`);
  } else {
    for (let step = 1; step <= MAX_ACTIONS_PER_INVOCATION; step++) {
      if (state.totalInvocations >= state.maxInvocations) {
        onProgress?.(`${indent}  global invocation cap reached`);
        break;
      }
      const budget = MAX_ACTIONS_PER_INVOCATION - step + 1;
      const remaining = state.maxInvocations - state.totalInvocations;
      const planPrompt = buildPlanPrompt(
        projectName,
        date,
        scope,
        question,
        observations,
        budget,
        depth,
        coherenceToken,
        coveredSpans,
        remaining
      );
      let plan: Record<string, unknown>;
      try {
        const r = await callLlm(planPrompt, PLAN_SCHEMA, settings);
        plan = r.parsed;
      } catch (err) {
        onProgress?.(`${indent}  plan failed (${err}); forcing extract`);
        break;
      }
      const action = String(plan.action);
      const reasoning =
        typeof plan.reasoning === "string" && plan.reasoning.trim()
          ? plan.reasoning.slice(0, 100)
          : "(no reasoning given)";
      onProgress?.(`${indent}  step ${step}: ${action} — ${reasoning}`);

      if (action === "done") {
        const claimedToken = String(plan.coherence_token ?? "");
        const { covered } = mergeSpans(coveredSpans);
        const issues: string[] = [];
        if (claimedToken !== coherenceToken)
          issues.push(`token mismatch (got "${claimedToken}")`);
        if (covered < scopeLen)
          issues.push(`coverage ${covered}/${scopeLen} below 100%`);
        if (issues.length > 0) {
          onProgress?.(`${indent}    done REJECTED: ${issues.join("; ")}`);
          observations.push({
            step,
            action: "done-rejected",
            detail: "",
            result: issues.join("; "),
          });
          continue;
        }
        onProgress?.(`${indent}    done accepted`);
        break;
      }

      if (action === "search") {
        const query = String(plan.query ?? "");
        const hits = tool_search(transcript, scope, query);
        const result =
          hits.length === 0
            ? "(no hits)"
            : hits
                .map(
                  (h) =>
                    `  offset=${h.offset}  ${JSON.stringify(h.preview)}`
                )
                .join("\n");
        observations.push({
          step,
          action: "search",
          detail: JSON.stringify(query),
          result,
        });
        continue;
      }

      if (action === "read_range") {
        let start = Math.max(0, Math.min(scopeLen, Number(plan.start ?? 0)));
        let end = Math.max(
          start,
          Math.min(scopeLen, Number(plan.end ?? start + READ_WINDOW), start + READ_WINDOW)
        );
        if (end <= start) {
          observations.push({
            step,
            action: "read_range",
            detail: `${start}, ${end}`,
            result: "(empty)",
          });
          continue;
        }
        const text = tool_read_range(transcript, scope, start, end);
        const actualEnd = start + text.length;
        coveredSpans.push([start, actualEnd]);
        observations.push({
          step,
          action: "read_range",
          detail: `${start}, ${actualEnd}`,
          result: text,
        });
        continue;
      }

      if (action === "spawn") {
        if (scopeLen <= READ_WINDOW) {
          observations.push({
            step,
            action: "spawn",
            detail: "",
            result: "(rejected: spawn forbidden at leaf scope)",
          });
          continue;
        }
        const subStart = Number(plan.start ?? 0);
        const subEnd = Number(plan.end ?? subStart + READ_WINDOW);
        const subQuestion = String(plan.sub_question ?? question);
        const validation = validateSpawnRange(scopeLen, subStart, subEnd);
        if (validation !== null) {
          observations.push({
            step,
            action: "spawn",
            detail: `${subStart}, ${subEnd}`,
            result: `(rejected: ${validation})`,
          });
          continue;
        }
        const childScope: Scope = {
          globalStart: scope.globalStart + subStart,
          globalEnd: scope.globalStart + subEnd,
          label: `${scope.label}/[${subStart}-${subEnd}]`,
        };
        coveredSpans.push([subStart, subEnd]);
        const child = await invokeRecursive(
          transcript,
          projectName,
          date,
          childScope,
          subQuestion,
          config,
          depth + 1,
          state,
          summaryInstructions,
          onProgress
        );
        const result = child.result.skipped
          ? `(child skipped: ${child.result.skipReason})`
          : `HEADLINE: ${child.result.headline}\nSUMMARY: ${child.result.summary}\nTOPICS: ${JSON.stringify(child.result.topics)}\nOPEN_QUESTIONS: ${JSON.stringify(child.result.openQuestions)}`;
        observations.push({
          step,
          action: "spawn",
          detail: `${subStart}-${subEnd}`,
          result,
        });
        continue;
      }

      onProgress?.(`${indent}    unknown action ${action}; forcing extract`);
      break;
    }
  }

  // Extract phase
  const extractPrompt = buildExtractPrompt(
    projectName,
    date,
    scope,
    question,
    observations,
    summaryInstructions
  );
  let extracted: Record<string, unknown>;
  try {
    const r = await callLlm(extractPrompt, EXTRACT_SCHEMA, settings);
    extracted = r.parsed;
    onProgress?.(`${indent}  extract done`);
  } catch (err) {
    return {
      result: {
        skipped: true,
        skipReason: `extract_error: ${err instanceof Error ? err.message : String(err)}`,
      },
      coveredSpans,
      modelUsed: settings.model,
    };
  }

  return {
    result: parseExtractResponse(extracted),
    coveredSpans,
    modelUsed: settings.model,
  };
}

/** Public entry point. Run the recursive orchestrator on a transcript that
 *  exceeds the one-shot context budget. Returns the structured summary plus
 *  metadata for diagnostics. */
export async function summarizeRecursive(
  projectName: string,
  date: string,
  transcript: string,
  config?: Partial<SummarizerConfig>,
  options?: {
    /** Hard cap on total invocations across the recursion tree. Defaults
     *  to a budget that scales with transcript size — roughly enough for
     *  a binary subdivision down to leaf size. */
    maxInvocations?: number;
    /** Per-step progress callback for visibility into the recursion. */
    onProgress?: (msg: string) => void;
  }
): Promise<RecursiveResult> {
  const summaryInstructions = config?.summary_instructions;
  const rootScope: Scope = {
    globalStart: 0,
    globalEnd: transcript.length,
    label: "root",
  };
  // Budget: rough estimate is total leaves ≈ transcript_len / READ_WINDOW,
  // plus interior nodes ≈ leaves. Multiply by safety factor.
  const defaultBudget = Math.max(
    30,
    Math.ceil((transcript.length / READ_WINDOW) * 3)
  );
  const state = {
    totalInvocations: 0,
    maxInvocations: options?.maxInvocations ?? defaultBudget,
  };
  const { result, coveredSpans, modelUsed } = await invokeRecursive(
    transcript,
    projectName,
    date,
    rootScope,
    `Engineering work done on project "${projectName}" on ${date}. Produce a journal entry.`,
    config,
    0,
    state,
    summaryInstructions,
    options?.onProgress
  );
  return {
    parsed: result,
    modelUsed,
    coveredSpans,
    scope: rootScope,
    totalInvocations: state.totalInvocations,
  };
}
