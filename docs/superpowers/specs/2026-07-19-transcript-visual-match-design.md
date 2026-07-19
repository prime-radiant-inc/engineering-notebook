# Transcript Visual Match (React viewer) — Design

**Date:** 2026-07-19
**Status:** Approved
**Branch:** `feature/session-groups`
**Builds on:** `2026-07-19-show-thinking-tools-design.md` (the enriched transcript render)

## Motivation

The enriched transcript (Show thinking / Show tools) currently renders plainly: thinking as a left-border strip, and every tool call fully expanded in a bordered box — unreadable when a session has hundreds of tool calls (one test session has 505 tool blocks). The reference `prime-radiant-inc/claude-session-viewer` reads far better: **collapsible** tool calls showing just a name + one-line preview, thinking as a compact rounded bubble, and a teal-accented, rounded aesthetic. This spec adopts the **Core match** of that look.

## Scope (Core match)

- **Collapsible tool calls.** Each `tool_use` renders as a native `<details>`: the `<summary>` shows the **tool name** (teal accent) + a **one-line preview**; expanding reveals the full input and, paired inside, the tool's **result**.
- **Tool preview** per tool: `Read`/`Write`/`Edit` → `file_path`; `Bash` → `command` (truncated to 80 chars); `Glob`/`Grep` → `pattern`; `Task` → `description`; `WebFetch` → `url`; otherwise empty.
- **Result pairing.** A `tool_result` is rendered inside its matching `tool_use` (`tool_use.id === tool_result.tool_use_id`), not as a standalone block. Orphan results (no matching call in the visible set) render standalone.
- **Thinking bubble.** `thinking` renders as a compact rounded bubble (surface background, muted italic) with a "~N tokens" estimate (`round(len/4)`) in the corner when content is long (> 100 chars).
- **Aesthetic.** Rounded corners, a teal accent token, panel/surface backgrounds — using the notebook's existing warm-neutral tokens plus one new `--accent` teal.
- **Text stays as-is:** escaped, whitespace-preserved (no markdown rendering — that was the deliberately-excluded larger scope).

## Non-Goals

- No markdown rendering of message text (Core match excludes it).
- No red/green diff view for `Edit` tools (that was Full parity).
- No new dependencies. No changes to ingest/storage/search/summary.
- No change to the default text-only view, the toggle controls, the route, or the warning/fallback behavior — only the *enriched-block rendering* and its CSS change.
- The notebook is light-only; no dark-theme work.

## Components

### 1. Parser enrichment — `src/transcript.ts`
`TranscriptItem` gains structured tool fields (all optional, so text/thinking items are unaffected):

```ts
export type TranscriptItem = {
  role: TranscriptRole;
  kind: TranscriptKind;
  content: string;              // text/thinking text; tool_use → pretty JSON input (kept as fallback); tool_result → result text
  name?: string;               // tool_use: tool name
  id?: string;                 // tool_use: block id (for pairing)
  toolUseId?: string;          // tool_result: the id it answers
  input?: Record<string, unknown>; // tool_use: structured input (for preview + rendering)
};
```

- `tool_use` items additionally set `id` (`block.id`) and `input` (`block.input` when it is an object).
- `tool_result` items additionally set `toolUseId` (`block.tool_use_id`).
- Everything else (kinds, ordering, roles, codex handling, `content` values) is unchanged — existing items keep working; new fields are additive.

### 2. Rendering — `src/web/views/session.ts`
- New pure helper `toolPreview(name: string, input: Record<string, unknown> | undefined): string` implementing the per-tool preview table above (empty string when nothing matches).
- `renderTranscriptItems(items, showThinking, showTools)` reworked:
  - Build `resultsByToolUseId: Map<string, string>` from `tool_result` items (id → content).
  - Track which result ids get consumed by a rendered tool_use.
  - For each item in order:
    - `text` → unchanged (escaped, role label).
    - `thinking` (if `showThinking`) → bubble markup (`.transcript-thinking`) + token estimate span when long.
    - `tool_use` (if `showTools`) → `<details class="transcript-tool">` with `<summary>`: `<span class="tool-name">name</span>` + `<span class="tool-preview">preview</span>`; body: `<pre>` of the input (from `input` pretty-printed, else `content`) and, if a paired result exists, a `<div class="tool-result"><pre>…</pre></div>`. Mark that result id consumed.
    - `tool_result` (if `showTools`) → **skipped if consumed**; otherwise rendered standalone (orphan) in a `.transcript-tool` box.
  - Keep the existing dimension-specific "No thinking/tool data" notes (from the prior fix) — unchanged.
  - All dynamic content still `escapeHtml`-ed (tool name, preview, input, result).
- `renderSessionDetail` signature and control/warning/fallback logic unchanged.

### 3. Styles — `src/web/views/layout.ts`
- Add `--accent: #1a6b5a;` to `:root`.
- Restyle the transcript classes:
  - `.transcript-thinking` → rounded bubble: `background:var(--surface); border-radius:14px 14px 14px 4px; padding:10px 14px; color:var(--text-muted); font-style:italic; font-size:12px; white-space:pre-wrap;` plus a `.transcript-thinking .tokens` corner style (`text-align:right; font-size:10px; color:var(--text-ghost); font-style:normal;`).
  - `.transcript-tool` (now a `<details>`) → `border:1px solid var(--border); border-radius:10px; padding:6px 10px; margin:8px 0; font-size:12px;`
  - `.transcript-tool > summary` → `cursor:pointer; list-style:none; color:var(--text-muted);` with `.tool-name { color:var(--accent); font-weight:600; font-family:var(--font-sans); }` and `.tool-preview { color:var(--text-faint); margin-left:8px; font-family:monospace; }`
  - `.transcript-tool pre` → `white-space:pre-wrap; margin:6px 0 0; font-family:monospace; font-size:11px;`
  - `.transcript-tool .tool-result` → `border-top:1px solid var(--border-subtle); margin-top:6px; padding-top:6px;`
  - Keep `.transcript-toggle` and `.transcript-warning` as-is.

## Edge Cases

| Case | Behavior |
|------|----------|
| `tool_use` with no `input` | Summary shows name only (empty preview); body shows empty/`content` string. |
| `tool_result` with no matching `tool_use` in the set | Rendered standalone in a tool box. |
| Same `tool_use.id` referenced by multiple results | First consumes; extras render standalone (defensive; shouldn't occur). |
| Long thinking (>100 chars) | Token estimate shown; short thinking omits it. |
| Tools shown, thinking hidden (or vice-versa) | Only the shown kind rendered; dimension-specific note if the shown kind has no data. |
| Preview/input/result contain HTML | Escaped. |

## Testing

**`src/transcript.test.ts`** (extend)
- `tool_use` item carries `id`, `name`, and structured `input`; `tool_result` item carries `toolUseId`. Existing assertions updated for the additive fields (text/thinking items unchanged).

**`src/web/views/session.test.ts`** (extend)
- `showTools` render: tool renders as `<details>` with `tool-name` and a preview (e.g. Bash command); the full input is inside; a matching result is paired inside the same `<details>` and not rendered standalone.
- `toolPreview` unit cases (Bash/Read/Grep/Task/unknown).
- Thinking render shows the bubble class and a token-estimate for long content.
- Default (no flags) unchanged; escaping preserved.

## Rollout

Additive parser fields, a reworked render helper, and CSS. No new deps, no data changes. Only the enriched-block markup/appearance changes; default view, toggles, route, and fallback are untouched.
