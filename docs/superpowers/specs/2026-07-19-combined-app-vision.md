# Combined App — Vision & Roadmap (React frontend on the engineering-notebook backend)

**Date:** 2026-07-19
**Status:** Draft for review (umbrella doc — each phase gets its own spec → plan → build)
**Decision context:** Keep engineering-notebook's backend (ingest, Claude summaries, journal, SQLite); build a new **React** frontend that matches `claude-session-viewer`'s session display; add Claude Desktop **group** functionality.

## 1. Vision

One local app that combines:
- **From engineering-notebook (backend, kept):** ingest of Claude Code + Codex sessions, **Claude LLM summaries → journal**, projects, calendar, search, iCal, session groups.
- **From claude-session-viewer (display, rebuilt in React):** polished session transcript — collapsible tool calls, diff view, thinking blocks, conversation minimap, **subagent nesting**, branch switching, and first-class **Hide/Show thinking & tools**.
- **New:** Claude Desktop group import (and later write-back), and correct **session-chain modeling** (subagents nested under their parent).

The through-line: engineering-notebook's *analysis* features with the viewer's *reading* experience.

## 2. Key facts established during design (evidence-based)

- **Resuming a session continues the same session.** A non-subagent session = exactly one `<sessionId>.jsonl` file (verified across 364 real sessions: filename == internal sessionId, none span multiple files); resuming appends to that same file. There is **no** parent-linked "new session on resume."
- **Subagents are the multi-file case.** `agent-*` / sidechain files (174 of them) carry the *parent's* sessionId — one logical session, many files. **Current engineering-notebook does not stitch these together** (it de-dupes by sessionId per file); the new app must nest subagents under their parent.
- **`parentUuid`** threads messages into a tree within a session (edits/rewinds → branches).
- **Thinking is often empty** (only 25/521 sessions have thinking text; Claude Code omits the rest); **tools are populated broadly.** The UI must gracefully show "nothing to reveal" states.
- **Desktop groups are locally readable** at `Local Storage/leveldb` key `dframe-group-scopes` (`{value:{<scope>:{groups:[{id:"cg-…",name}], assignments:{"code:local_<uuid>":groupId}}}}`), joinable to notebook sessions via `local_<uuid>.json → cliSessionId → sessions.id`. Write-back requires Desktop closed (LevelDB lock).

## 3. Architecture

### 3.1 Recommendation: new frontend **inside** the engineering-notebook repo (monorepo)
You said the goal is "so we can incorporate any engineering-notebook enhancements." That is easiest when backend and frontend live and version together. **Recommend: one repo.**
- Backend stays **Bun + Hono + bun:sqlite**, refactored to expose a **JSON API** (the existing `renderX` view functions are replaced by JSON endpoints).
- Frontend: **React + Vite + TypeScript** in a `web/` subdirectory. In dev, Vite proxies `/api/*` to Hono; in prod, Hono serves the built static assets plus the API.
- Reuse the viewer's component *approach* (React Router optional; a single Vite SPA with client routing is simpler here). Port Tailwind or map to the notebook's existing tokens — TBD in the Phase 1 spec.
- **Coexistence:** keep the current server-rendered views working until the React app reaches parity, then retire them. No data migration.

*(Alternative considered — a separate repo consuming the backend as a library/API — is viable but makes "keep both in sync" harder; deferred unless you prefer a clean split.)*

### 3.2 Data-model changes (backend)
- **Structured transcript endpoint.** Today the backend stores only lossy text markdown. Add an on-demand endpoint that parses a session's JSONL into **structured blocks** (text/thinking/tool_use/tool_result with ids), so the React viewer can render and toggle them. (Generalizes the `src/transcript.ts` we already built.)
- **Subagent nesting.** Associate `agent-*`/sidechain files with their parent session (by shared sessionId + the spawning tool_use id) so the UI can nest them. Likely a `parent_session_id` / `is_subagent` correction + an API that returns the tree.
- **Groups.** Reuse the `groups`/`session_groups` schema and the `desktop-groups` reader/`importDesktopGroups` we specced; expose via API.
- Summaries/journal/projects/calendar/search: expose existing logic as JSON.

## 4. Feature synthesis (what the combined app has, and its source)

| Area | Source | Notes |
|---|---|---|
| Ingest (Claude Code + Codex) | notebook | keep; fix subagent stitching |
| Claude summaries → journal | notebook | keep; expose via API |
| Projects / Calendar / Search / iCal | notebook | re-render in React |
| Session transcript (collapsible tools, diff, thinking, minimap) | viewer | rebuild in React |
| Hide/Show thinking & tools | viewer (structured) | native/structured, replacing our re-parse toggle |
| Subagent panels / nesting | viewer | needs backend stitching |
| Branch switcher (`parentUuid`) | viewer | optional, later phase |
| Session groups | notebook (new) | manual + Desktop import |
| Desktop group import / write-back | new | Phase-1 import spec already written; write-back later |

## 5. Phased roadmap (recommended order; each phase = its own spec → plan → build)

**Phase 1 — Foundation + session display parity (the core UX).**
React/Vite app in-repo, served by Hono; JSON API for the session list and a **structured transcript** endpoint; the polished session viewer with **Hide/Show thinking & tools**, collapsible tools, and **subagent nesting**. Deliverable: browse sessions and read them beautifully. *Rationale: this is the experience you most want, and it forces the API + structured-transcript + subagent groundwork everything else builds on.*

**Phase 2 — Journal & summaries in React.** Surface the existing summarization/journal via API + React views (daily journal, entry detail, on-demand summarize).

**Phase 3 — Projects / Calendar / Search / iCal in React.** Port the remaining views.

**Phase 4 — Session Groups.** Manual groups + **Desktop import** (adapt the already-written import spec/plan to the API + React), then **Desktop write-back** (Phase 2 of groups) with the closed-app safeguards.

**Phase 5 — Polish & retire server-rendered views.** Branch switcher, minimap, empty-state affordances, remove the old Hono HTML views.

*Reordered from the current queue:* the standalone Desktop-import and any further notebook tweaks fold into Phase 4 / the backend API work, so they're not wasted.

## 6. Open questions / risks

- **Styling system:** adopt the viewer's Tailwind, or map to the notebook's existing tokens? (Phase 1 spec decides.)
- **Client routing/SPA vs SSR:** recommend a Vite SPA + Hono API for simplicity; revisit if SEO/first-paint matters (it's a local tool, so it doesn't).
- **Subagent stitching correctness:** the spawning relationship must be derived reliably (shared sessionId + tool_use → agentId). Needs a data spike in Phase 1.
- **Scope creep:** the viewer has a lot (minimap, branches). Phase 1 targets the 80% (tools/thinking/subagents); minimap/branches are Phase 5.
- **Effort:** this is a multi-week rebuild. Phasing keeps each step shippable and reviewable.

## 7. Immediate next step

On approval of this vision: write the **Phase 1 spec** (Foundation + session display parity) — API surface, structured-transcript + subagent-tree endpoints, the React app skeleton, and the viewer components to build first — then plan → build it via the usual flow.
