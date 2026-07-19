# Phase 1 — Foundation + Session Display Parity — Design

**Date:** 2026-07-19
**Status:** Draft for review
**Umbrella:** `2026-07-19-combined-app-vision.md` (Phase 1 of 5)
**Branch:** a new `feature/react-frontend` off `feature/session-groups` (TBD at plan time)

## Goal

Stand up a **React frontend inside the engineering-notebook repo**, served by the existing Hono backend via a **JSON API**, delivering a polished **session viewer** — collapsible tool calls, thinking blocks, **subagent nesting**, and first-class **Hide/Show thinking & tools** — reading structured data parsed from the original JSONL. This is the foundation (API + structured transcript + build wiring) that later phases build on.

## Scope (Phase 1 only)

- Monorepo layout: React/Vite app in `web/`, Hono serves the API and (in prod) the built assets.
- JSON API: session **list**, session **metadata**, **structured transcript**, **subagent** transcript.
- React app: a **session list** view and a **session detail** view with the viewer components below.
- Session viewer: message stream (user/assistant), **collapsible `<details>` tool calls** with name + preview + paired result, **thinking blocks**, **subagent panels** (lazy-loaded), and client-side **Hide/Show thinking** + **Hide/Show tools** toggles (structured, no re-parse round-trip).
- Styling: **Tailwind** (as the viewer components assume).

## Out of scope (later phases)

- Journal/summaries (Phase 2), projects/calendar/search (Phase 3), groups + Desktop import/write-back (Phase 4), minimap + branch switcher + diff view + retiring old views (Phase 5).
- No changes to ingest/summarize/DB schema. The old server-rendered Hono views keep working, untouched.

## Architecture

### Repo & build
- `web/` — Vite + React + TypeScript + Tailwind SPA (client-side routing).
- Backend (`src/`) adds an **API router** mounted at `/api` in the existing Hono app (`createApp`), alongside the current routes.
- **Dev:** run Vite dev server (e.g. `:5173`) proxying `/api/*` to Hono (`:3000`); `engineering-notebook serve` still runs the Hono app.
- **Prod:** `vite build` → `web/dist`; Hono serves `web/dist` static assets for non-`/api` routes (SPA fallback to `index.html`). A new `serve --react` flag (or a config toggle) selects the React app; the legacy views remain at their paths until Phase 5.
- Bun stays the runtime and test runner. Vite/React are dev/build deps.

### Backend: structured transcript (generalize `src/transcript.ts`)
- `parseTranscriptStructured(jsonlText)` → ordered blocks preserving message boundaries: `{ role, uuid, parentUuid, timestamp, blocks: Block[] }[]` where `Block = text | thinking | tool_use{id,name,input} | tool_result{toolUseId,content}`. (Extends the existing `parseTranscript`; keeps ids for pairing and message threading for later branch support.)
- Reads the session's `source_path`; falls back to `{error:"source unavailable"}` when missing.

### Backend: subagent discovery + mapping (exact, via `.meta.json`)
On-disk layout confirmed by spike: `<project>/<sessionId>/subagents/agent-<agentId>.jsonl`, each with a sibling `agent-<agentId>.meta.json`:
```json
{ "agentType": "general-purpose", "description": "Implement Task 1: transcript parser",
  "toolUseId": "toolu_01Up…", "spawnDepth": 1 }
```
- Discover subagents by listing `<project>/<sessionId>/subagents/`.
- **Map each subagent to its parent `Task` tool_use *exactly* via `meta.toolUseId`** — no prompt-matching heuristic needed (the viewer's approach is superseded). `description`, `agentType`, and `spawnDepth` come from the meta file; `spawnDepth > 1` means a subagent spawned by another subagent (nest recursively).
- `GET /api/subagent/:sessionId/:agentId` returns that subagent's structured transcript.

### API surface (Phase 1)
| Method/Path | Returns |
|---|---|
| `GET /api/sessions?limit&offset&project&q` | paginated session list: id, project, title/first-prompt, started/ended, message count, has-subagents, is-summarized (best-effort from existing tables) |
| `GET /api/sessions/:id` | session metadata + the list of `{agentId, description, agentType, toolUseId, spawnDepth}` subagents (from each `.meta.json`) |
| `GET /api/sessions/:id/transcript` | structured transcript (blocks) for the main session |
| `GET /api/subagent/:sessionId/:agentId` | structured transcript for one subagent |

All JSON; errors as `{ error }` with appropriate status. These are additive (new `/api/*` routes); existing routes untouched.

### Frontend
- **Routes:** `/` (session list), `/s/:id` (session detail). Client-side router.
- **Session list:** rows with title/first-prompt, project, date, counts; links to detail. (Search/filter minimal in Phase 1; full search is Phase 3.)
- **Session detail:** fetches `/api/sessions/:id` + `/transcript`; renders the message stream via:
  - `MessageBlock` — role, timestamp, text (markdown via `react-markdown` + `remark-gfm`).
  - `ThinkingBlock` — bubble; hidden unless "Show thinking".
  - `ToolCallBlock` — `<details>` with tool name + preview (Read/Write/Edit→file_path, Bash→command≤80, Glob/Grep→pattern, Task→description, WebFetch→url) and the paired `tool_result` inside; hidden unless "Show tools".
  - `SubagentPanel` — for each mapped subagent, an expandable panel that lazy-loads `/api/subagent/...` and renders it with the same components (recursively supports nested subagents).
  - **Toggles:** two buttons controlling client state `showThinking` / `showTools` (default **off**), toggling visibility of already-loaded structured blocks (no server round-trip). Empty-state note when the shown kind has no data.
- **Styling:** Tailwind; a small token set approximating the notebook's warm palette + a teal accent (or the viewer's palette — decided in the plan; default: viewer's).

## Testing

- **Backend (bun test):** `parseTranscriptStructured` returns correct ordered blocks incl. ids + message threading (fixtures for Claude + Codex); subagent discovery finds `agent-*` files for a session; subagent→Task prompt-matching maps correctly and lists unmatched; each API endpoint returns the right shape and 404s appropriately (fixture DB + fixture JSONL).
- **Frontend (vitest + Testing Library):** session detail renders messages; tool calls are collapsed by default and reveal input + paired result on "Show tools"; thinking hidden until "Show thinking"; subagent panel lazy-loads and renders; empty-state note shows when a shown kind is absent.
- **Smoke:** dev + prod build serve the app; a real session with tools+thinking+subagents renders and toggles correctly.

## Risks / decisions deferred to the Phase 1 plan

- **On-disk subagent layout** — RESOLVED by spike: `<project>/<sessionId>/subagents/agent-<id>.jsonl` + `.meta.json` with an exact `toolUseId`. No longer a risk.
- **Vite ↔ Hono wiring** (dev proxy + prod static serving under Bun) — a small integration spike (plan Task 1).
- **Tailwind vs notebook tokens** — pick in the plan; lean Tailwind.
- **Session-list "title"** — reuse the existing display_name/first-prompt logic.
- Keep Phase 1 to the 80%: no diff view, minimap, or branch switcher (Phase 5).

## Rollout

Purely additive: new `web/` app, new `/api/*` routes, new build wiring behind a flag. Legacy views and all backend data/logic unchanged. Nothing ships to users automatically; the React app is opt-in until parity across phases.
