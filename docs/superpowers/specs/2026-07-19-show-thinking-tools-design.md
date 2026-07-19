# Show / Hide Thinking & Tools on the Session Display — Design

**Date:** 2026-07-19
**Status:** Approved
**Branch:** `feature/session-groups`
**Sequencing:** Implement **before** the Desktop Group Import (Phase 1) work.

## Motivation

The reference app `prime-radiant-inc/claude-session-viewer` lets a reader toggle **Thinking** and **Tools** visibility in a session transcript. engineering-notebook can't do this today because its ingest **discards** thinking and tool content: `src/parser.ts` keeps only `text` blocks (`extractAssistantText` — "Only extract text blocks — skip thinking, tool_use, and everything else"; `extractUserText` drops whole messages containing `tool_result`). The stored `conversation_markdown` is text-only.

Approach (chosen): **re-parse the original JSONL on demand.** The default session view keeps rendering the stored text-only markdown; only when the user chooses **Show thinking** and/or **Show tools** does the server re-parse the session's `source_path` JSONL and render the richer transcript. No schema change, no re-ingest, no impact on search/summaries.

## Requirements

- On `/session/:id`, two independent controls: **Show thinking** and **Show tools**, both **hidden by default**.
- Controls are query-param links: `/session/:id?thinking=1` and `?tools=1`, independently combinable; clicking a "Show" control adds its param, clicking "Hide" removes it.
- **Default (no params):** render the current text-only view from stored `conversation_markdown` (unchanged behavior). No JSONL read.
- **When `thinking=1` and/or `tools=1`:** re-parse the session's `source_path` JSONL into an ordered transcript and render text + thinking (if `thinking=1`) + tool calls/results (if `tools=1`). The active controls flip to **Hide thinking** / **Hide tools**.
- **If a param is set but the source file is missing/unreadable:** show a warning banner ("Original session file unavailable — can't show thinking/tools") and fall back to the stored text-only view; the controls still render (so the user can turn the request off).
- **Claude Code** JSONL is fully supported. **Codex** sessions (different format) render text plus a small note "No thinking/tool data for this session" when Show is requested.
- Scope: the dedicated **`/session/:id`** display only. The inline session panel used inside the journal/projects three-panel views stays text-only.

## Non-Goals

- No changes to ingest, storage, search, or summaries.
- No client-side framework; toggles are server round-trips via query-param links (progressive, works without JS).
- No toggles on the inline three-panel session panel (only the dedicated `/session/:id` view).
- No persistence of the toggle preference across sessions/pages (it lives in the URL).

## Components

### 1. Transcript parser — `src/transcript.ts` (new)
- `type TranscriptItem = { role: "user" | "assistant"; kind: "text" | "thinking" | "tool_use" | "tool_result"; content: string; name?: string }`
- `parseTranscript(jsonlText: string): { items: TranscriptItem[]; format: "claude" | "codex" | "unknown" }`
  - Splits JSONL by line, JSON-parses each record, walks records in file order.
  - For **Claude Code** records (`type: "user" | "assistant"`, `message.content` an array of blocks): emit one `TranscriptItem` per block in order — `text` → text; `thinking` → thinking (`block.thinking`); `tool_use` → tool_use (`name` = `block.name`, `content` = pretty-printed `block.input`); `tool_result` → tool_result (`content` = stringified `block.content`). String `message.content` → a single text item.
  - For **Codex** records: emit text items only (`input_text`/`output_text`); `format: "codex"`.
  - Unrecognized/blank lines skipped. Returns `format: "unknown"` if no records parsed.
- Pure function (no fs), unit-testable with fixture strings.

### 2. Enriched rendering — `src/web/views/session.ts`
- `renderSessionDetail(db, sessionId, opts?: { showThinking?: boolean; showTools?: boolean }): string`
  - `opts` defaults to both false → **current behavior unchanged** (stored markdown).
  - Header always renders the two toggle controls (see below).
  - If `showThinking || showTools`:
    - Read `session.source_path` (already selected by the existing query). If the file is missing or unreadable → render a warning banner, then fall through to the text-only markdown render.
    - Else read the file, `parseTranscript(text)`; if `format === "codex"` and neither thinking nor tools exist, render text items + a muted note "No thinking/tool data for this session."
    - Render items in order: always render `text`; render `thinking` items only if `showThinking`; render `tool_use`/`tool_result` items only if `showTools`. Thinking styled muted; tool blocks styled monospace/boxed. All content `escapeHtml`-ed.
  - Toggle controls: two links in the metadata header. Each builds the target URL from the current `sessionId` and the *other* param's current state, so toggling one preserves the other (e.g. when `showTools` is on, the thinking link is `/session/:id?tools=1&thinking=1`). Label is "Show thinking"/"Hide thinking" and "Show tools"/"Hide tools" per current state.
- Helper `renderTranscriptItems(items, { showThinking, showTools }): string` for the enriched body (keeps the function focused and testable).

### 3. Route — `src/web/server.ts`
- `GET /session/:id` reads `thinking`/`tools` query params (`=== "1"`) and passes `{ showThinking, showTools }` to `renderSessionDetail`. The rest of the three-panel layout is unchanged.

### 4. Styles — `src/web/views/layout.ts`
- `.transcript-thinking` (muted, subtle left border) and `.transcript-tool` (monospace, boxed) classes, plus a `.transcript-warning` banner style. Theme-consistent with existing tokens.

## Edge Cases

| Case | Behavior |
|------|----------|
| No params | Text-only stored markdown (unchanged); both controls say "Show …". |
| `thinking=1`, file present | Text + thinking rendered; tools hidden; thinking control says "Hide thinking". |
| `tools=1`, file present | Text + tool calls/results; thinking hidden. |
| Param set, source file missing/unreadable | Warning banner + text-only fallback; controls still shown so the user can toggle off. |
| Codex session, Show requested | Text items + "No thinking/tool data for this session" note. |
| Malformed JSONL lines | Skipped individually; whatever parses is rendered. |
| Session has no stored markdown AND file missing | Existing "No conversation data." path preserved. |
| Very large JSONL | Parsed on demand for a single session; acceptable. |

## Testing

**`src/transcript.test.ts`**
- Claude fixture with text+thinking+tool_use+tool_result → items in file order with correct `kind`/`role`/`name`; `format: "claude"`.
- String-content record → single text item.
- Codex fixture → text-only items; `format: "codex"`.
- Malformed line skipped; empty input → empty items, `format: "unknown"`.

**`src/web/views/session.test.ts`** (append to existing)
- Default `renderSessionDetail` (no opts) → contains "Show thinking"/"Show tools", does NOT contain thinking/tool markup; matches current text render.
- With `{ showThinking: true }` against a session whose `source_path` points to a fixture JSONL → thinking content present, control says "Hide thinking"; tool content absent.
- With `{ showTools: true }` → tool content present.
- `source_path` missing → warning banner text present + text-only fallback.
- Toggle links preserve the other param (URL assertions).

**`src/web/server.test.ts`** (append)
- `GET /session/:id?thinking=1` returns 200 and Panel 3 shows thinking (fixture session); `GET /session/:id` (no params) does not.

## Rollout

Purely additive: a new module, a new render path behind default-off flags, a new route param, and CSS. No data migration, no ingest/search/summary impact. Falls back gracefully when source files are absent.
