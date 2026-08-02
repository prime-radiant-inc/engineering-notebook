# Phase 1 — Foundation + Session Display Parity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A React/Vite app in `web/`, served by the Hono backend via a JSON API, rendering a polished session viewer (collapsible tools, thinking, subagent nesting, client-side hide/show thinking & tools).

**Architecture:** Backend adds additive `/api/*` JSON routes (structured transcript, subagents, session list) to the existing Hono app; a Vite React SPA in `web/` consumes them (dev: Vite proxy → Hono; prod: Hono serves `web/dist`). No changes to ingest/summaries/DB or the legacy views.

**Tech Stack:** Bun (runtime + `bun test`), Hono, bun:sqlite; React + Vite + TypeScript + Tailwind (frontend); vitest + @testing-library/react (frontend tests).

## Global Constraints

- Runtime **Bun**. Backend tests: `bun test`. Frontend tests: `vitest` (run via `bun x vitest run` from `web/`).
- **Additive only:** new `/api/*` routes and a new `web/` app. Do NOT modify ingest/summarize/DB schema or the existing server-rendered routes/views. The React app is opt-in behind a `serve --react` flag.
- **Subagent layout (confirmed):** `<project>/<sessionId>/subagents/agent-<agentId>.jsonl` + sibling `agent-<agentId>.meta.json` = `{ agentType, description, toolUseId, spawnDepth }`. Map a subagent to its parent Task tool_use **exactly** via `meta.toolUseId`.
- **Claude JSONL blocks:** `{type:"user"|"assistant", message:{content}}`, content string or array of `text{text}` / `thinking{thinking}` / `tool_use{id,name,input}` / `tool_result{tool_use_id,content(string|array)}`. Records carry `uuid`, `parentUuid`, `timestamp`, `isSidechain`.
- **Codex JSONL:** `response_item` → `payload:{type:"message",role,content:[input_text|output_text]}}` — text only.
- API JSON on success; `{ error }` + status on failure. Reuse `src/transcript.ts` logic where possible.
- Toggles default **off**; thinking often empty → show an empty-state note.
- Tests assert real behavior; `bun run check` (backend) green before each backend commit; `vitest run` green before each frontend commit. Branch: `feature/react-frontend` (created in Task 1).

---

### Task 1: Repo scaffold + Vite↔Hono wiring (end-to-end "hello")

**Files:**
- Create: `web/` Vite React-TS app (`web/package.json`, `web/vite.config.ts`, `web/index.html`, `web/src/main.tsx`, `web/src/App.tsx`, `web/tailwind.config.js`, `web/postcss.config.js`, `web/src/index.css`)
- Create: `src/web/api/index.ts` (Hono sub-router mounted at `/api`)
- Modify: `src/web/server.ts` (mount `/api`; in prod, serve `web/dist` static + SPA fallback when a `react` flag is set)
- Modify: `src/index.ts` (`serve` reads a `--react` flag → pass to `createApp`/serving)
- Test: `src/web/api/api.test.ts`

**Interfaces:**
- Produces: `createApiRouter(db): Hono` mounted at `/api`; `GET /api/ping` → `{ ok: true }`.

- [ ] **Step 1: Create the branch + scaffold Vite app**

```bash
git checkout -b feature/react-frontend
mkdir -p web && cd web
bun create vite . --template react-ts   # accept overwrite into empty dir
bun add -d tailwindcss postcss autoprefixer @testing-library/react @testing-library/jest-dom jsdom vitest @vitejs/plugin-react
bunx tailwindcss init -p
cd ..
```
Configure `web/tailwind.config.js` `content: ["./index.html","./src/**/*.{ts,tsx}"]`; add the three `@tailwind` directives to `web/src/index.css`. Add to `web/vite.config.ts` a dev proxy:
```ts
server: { proxy: { "/api": "http://localhost:3000" } },
test: { environment: "jsdom", globals: true, setupFiles: "./src/test-setup.ts" },
```
Create `web/src/test-setup.ts` with `import "@testing-library/jest-dom";`.

- [ ] **Step 2: Write the failing backend test**

Create `src/web/api/api.test.ts`:
```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../../db";
import { createApiRouter } from "./index";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("api router", () => {
  let tempDir: string, db: ReturnType<typeof initDb>;
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), "api-")); db = initDb(join(tempDir, "t.db")); });
  afterEach(() => { closeDb(); rmSync(tempDir, { recursive: true, force: true }); });

  test("GET /api/ping returns ok", async () => {
    const app = createApiRouter(db);
    const res = await app.request("/ping");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test src/web/api/api.test.ts`
Expected: FAIL — `Cannot find module './index'`.

- [ ] **Step 4: Implement the router + mount + hello page**

Create `src/web/api/index.ts`:
```ts
import { Hono } from "hono";
import { Database } from "bun:sqlite";

export function createApiRouter(db: Database): Hono {
  const api = new Hono();
  api.get("/ping", (c) => c.json({ ok: true }));
  return api;
}
```
In `src/web/server.ts`, inside `createApp`, mount it: `app.route("/api", createApiRouter(db));` (add the import). Add optional prod static serving: when a `react` option is passed to `createApp`, use Hono's `serveStatic` for `web/dist` with SPA fallback to `web/dist/index.html` for non-`/api` GETs. Thread a `--react` flag from `src/index.ts`'s `serve` case.
Replace `web/src/App.tsx` with a component that fetches `/api/ping` and renders "API ok" when `{ok:true}`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/web/api/api.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Verify the pipe end-to-end (manual)**

```bash
# terminal A: backend
engineering-notebook serve --react --port 3000
# terminal B: vite dev
cd web && bun run dev
# open the Vite URL → should show "API ok" (proxied /api/ping)
# prod: cd web && bun run build ; then engineering-notebook serve --react serves web/dist
```
Record that both dev (proxy) and prod (static) serve the app and reach `/api/ping`.

- [ ] **Step 7: Commit**

```bash
git add web src/web/api/index.ts src/web/server.ts src/index.ts src/web/api/api.test.ts package.json
git commit -m "feat(react): scaffold web/ Vite app + Hono /api router + wiring"
```

---

### Task 2: Structured transcript endpoint

**Files:**
- Create: `src/transcript-structured.ts` (message-grouped structured parse)
- Modify: `src/web/api/index.ts` (`GET /api/sessions/:id/transcript`)
- Test: `src/transcript-structured.test.ts`, `src/web/api/api.test.ts` (append)

**Interfaces:**
- Produces:
  - `type StructuredBlock = { kind:"text"|"thinking"|"tool_use"|"tool_result"; content:string; name?:string; id?:string; toolUseId?:string; input?:Record<string,unknown> }`
  - `type StructuredMessage = { role:"user"|"assistant"; uuid?:string; parentUuid?:string; timestamp?:string; blocks: StructuredBlock[] }`
  - `parseStructuredTranscript(jsonlText: string): { messages: StructuredMessage[]; format: "claude"|"codex"|"unknown" }`

- [ ] **Step 1: Write the failing test**

Create `src/transcript-structured.test.ts`:
```ts
import { describe, test, expect } from "bun:test";
import { parseStructuredTranscript } from "./transcript-structured";

test("groups blocks under messages, preserving ids and threading", () => {
  const lines = [
    JSON.stringify({ type:"assistant", uuid:"u1", parentUuid:null, timestamp:"t1", message:{ content:[
      { type:"thinking", thinking:"th" },
      { type:"text", text:"hi" },
      { type:"tool_use", id:"tu1", name:"Bash", input:{ command:"ls" } },
    ] } }),
    JSON.stringify({ type:"user", uuid:"u2", parentUuid:"u1", timestamp:"t2", message:{ content:[
      { type:"tool_result", tool_use_id:"tu1", content:"out" },
    ] } }),
  ].join("\n");
  const { messages, format } = parseStructuredTranscript(lines);
  expect(format).toBe("claude");
  expect(messages).toHaveLength(2);
  expect(messages[0]).toMatchObject({ role:"assistant", uuid:"u1", parentUuid:null, timestamp:"t1" });
  expect(messages[0]!.blocks.map(b=>b.kind)).toEqual(["thinking","text","tool_use"]);
  expect(messages[0]!.blocks[2]).toMatchObject({ kind:"tool_use", id:"tu1", name:"Bash", input:{ command:"ls" } });
  expect(messages[1]!.blocks[0]).toMatchObject({ kind:"tool_result", toolUseId:"tu1", content:"out" });
});

test("empty → no messages, unknown", () => {
  expect(parseStructuredTranscript("")).toEqual({ messages: [], format: "unknown" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/transcript-structured.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/transcript-structured.ts`**

Reuse the block-parsing logic from `src/transcript.ts` (import its `toolResultToString` by copying the small helper — keep modules independent), but group per record into `StructuredMessage`. Codex `response_item` → one message with text blocks. Full code:
```ts
export type StructuredBlock = { kind:"text"|"thinking"|"tool_use"|"tool_result"; content:string; name?:string; id?:string; toolUseId?:string; input?:Record<string,unknown> };
export type StructuredMessage = { role:"user"|"assistant"; uuid?:string; parentUuid?:string|null; timestamp?:string; blocks: StructuredBlock[] };
export type StructuredFormat = "claude"|"codex"|"unknown";

function resultToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b:any)=> b && typeof b==="object" && typeof b.text==="string" ? b.text : JSON.stringify(b)).join("\n");
  if (content == null) return "";
  return JSON.stringify(content, null, 2);
}

export function parseStructuredTranscript(jsonlText: string): { messages: StructuredMessage[]; format: StructuredFormat } {
  const messages: StructuredMessage[] = [];
  let format: StructuredFormat = "unknown";
  for (const line of jsonlText.split("\n")) {
    const t = line.trim(); if (!t) continue;
    let rec:any; try { rec = JSON.parse(t); } catch { continue; }

    if (rec?.type === "session_meta") { format = "codex"; continue; }
    if (rec?.type === "response_item") {
      const p = rec.payload;
      if (p?.type !== "message" || (p.role !== "user" && p.role !== "assistant")) continue;
      format = "codex";
      const blocks: StructuredBlock[] = [];
      for (const b of Array.isArray(p.content)?p.content:[]) {
        if ((b?.type==="input_text"||b?.type==="output_text") && typeof b.text==="string" && b.text && b.text!=="(no content)") blocks.push({ kind:"text", content:b.text });
      }
      if (blocks.length) messages.push({ role:p.role, timestamp:rec.timestamp, blocks });
      continue;
    }

    if (rec?.type !== "user" && rec?.type !== "assistant") continue;
    const role = rec.type as "user"|"assistant";
    const content = rec?.message?.content;
    const blocks: StructuredBlock[] = [];
    if (typeof content === "string") {
      if (content && content!=="(no content)") blocks.push({ kind:"text", content });
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (!b || typeof b!=="object") continue;
        switch (b.type) {
          case "text": if (typeof b.text==="string" && b.text && b.text!=="(no content)") blocks.push({ kind:"text", content:b.text }); break;
          case "thinking": if (typeof b.thinking==="string" && b.thinking) blocks.push({ kind:"thinking", content:b.thinking }); break;
          case "tool_use": blocks.push({ kind:"tool_use", name: typeof b.name==="string"?b.name:undefined, id: typeof b.id==="string"?b.id:undefined, input: b.input!=null && typeof b.input==="object"? b.input as Record<string,unknown>:undefined, content: b.input!=null? JSON.stringify(b.input,null,2):"" }); break;
          case "tool_result": blocks.push({ kind:"tool_result", toolUseId: typeof b.tool_use_id==="string"?b.tool_use_id:undefined, content: resultToString(b.content) }); break;
        }
      }
    } else continue;
    if (format==="unknown") format = "claude";
    if (blocks.length) messages.push({ role, uuid: rec.uuid, parentUuid: rec.parentUuid ?? null, timestamp: rec.timestamp, blocks });
  }
  return { messages, format };
}
```

- [ ] **Step 4: Add the endpoint + its test**

Append to `src/web/api/api.test.ts` a test that seeds a session row with a `source_path` pointing to a fixture JSONL, requests `/sessions/:id/transcript`, and asserts the messages shape (and 404 for a missing session). Implement in `src/web/api/index.ts`:
```ts
import { existsSync, readFileSync } from "fs";
import { parseStructuredTranscript } from "../../transcript-structured";
// ...
api.get("/sessions/:id/transcript", (c) => {
  const id = c.req.param("id");
  const row = db.query("SELECT source_path FROM sessions WHERE id = ?").get(id) as { source_path: string } | null;
  if (!row) return c.json({ error: "session not found" }, 404);
  if (!row.source_path || !existsSync(row.source_path)) return c.json({ error: "source unavailable" }, 410);
  return c.json(parseStructuredTranscript(readFileSync(row.source_path, "utf-8")));
});
```

- [ ] **Step 5: Run tests**

Run: `bun test src/transcript-structured.test.ts src/web/api/api.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/transcript-structured.ts src/transcript-structured.test.ts src/web/api/index.ts src/web/api/api.test.ts
git commit -m "feat(api): structured transcript parser + /api/sessions/:id/transcript"
```

---

### Task 3: Subagent discovery + endpoints

**Files:**
- Create: `src/subagents.ts` (discover + read `.meta.json`)
- Modify: `src/web/api/index.ts` (`GET /api/sessions/:id` incl. subagents; `GET /api/subagent/:sessionId/:agentId`)
- Test: `src/subagents.test.ts`, `src/web/api/api.test.ts` (append)

**Interfaces:**
- Produces:
  - `type Subagent = { agentId:string; agentType?:string; description?:string; toolUseId?:string; spawnDepth?:number }`
  - `discoverSubagents(projectDir: string, sessionId: string): Subagent[]` — reads `<projectDir>/<sessionId>/subagents/agent-*.meta.json` (+ falls back to files without meta as `{agentId}`).
  - `subagentFilePath(projectDir, sessionId, agentId): string`

- [ ] **Step 1: Write the failing test**

Create `src/subagents.test.ts` that builds a temp `<projectDir>/<sessionId>/subagents/` with two `agent-<id>.jsonl` + `.meta.json` fixtures and asserts `discoverSubagents` returns both with `toolUseId`/`description`/`spawnDepth` parsed, sorted deterministically; a subagent without a meta file still appears (agentId only); missing dir → `[]`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/subagents.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/subagents.ts`**

```ts
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

export type Subagent = { agentId:string; agentType?:string; description?:string; toolUseId?:string; spawnDepth?:number };

export function subagentDir(projectDir: string, sessionId: string): string {
  return join(projectDir, sessionId, "subagents");
}
export function subagentFilePath(projectDir: string, sessionId: string, agentId: string): string {
  return join(subagentDir(projectDir, sessionId), `agent-${agentId}.jsonl`);
}

export function discoverSubagents(projectDir: string, sessionId: string): Subagent[] {
  const dir = subagentDir(projectDir, sessionId);
  if (!existsSync(dir)) return [];
  const out: Subagent[] = [];
  for (const name of readdirSync(dir)) {
    const m = /^agent-(.+)\.jsonl$/.exec(name);
    if (!m) continue;
    const agentId = m[1]!;
    let meta: Partial<Subagent> = {};
    const metaPath = join(dir, `agent-${agentId}.meta.json`);
    if (existsSync(metaPath)) {
      try {
        const j = JSON.parse(readFileSync(metaPath, "utf-8"));
        meta = { agentType: j.agentType, description: j.description, toolUseId: j.toolUseId, spawnDepth: j.spawnDepth };
      } catch { /* ignore malformed meta */ }
    }
    out.push({ agentId, ...meta });
  }
  out.sort((a, b) => a.agentId.localeCompare(b.agentId));
  return out;
}
```

- [ ] **Step 4: Add endpoints + tests**

The session's project dir = `dirname(source_path)` where the main file is `<projectDir>/<sessionId>.jsonl`, so `projectDir = dirname(source_path)`. Add to `src/web/api/index.ts`:
```ts
import { dirname } from "path";
import { discoverSubagents, subagentFilePath } from "../../subagents";

api.get("/sessions/:id", (c) => {
  const id = c.req.param("id");
  const row = db.query("SELECT id, project_id, project_path, source_path, started_at, ended_at, message_count FROM sessions WHERE id = ?").get(id) as any;
  if (!row) return c.json({ error: "session not found" }, 404);
  const subagents = row.source_path ? discoverSubagents(dirname(row.source_path), id) : [];
  return c.json({ ...row, subagents });
});

api.get("/subagent/:sessionId/:agentId", (c) => {
  const { sessionId, agentId } = c.req.param();
  const row = db.query("SELECT source_path FROM sessions WHERE id = ?").get(sessionId) as { source_path: string } | null;
  if (!row) return c.json({ error: "session not found" }, 404);
  const path = subagentFilePath(dirname(row.source_path), sessionId, agentId);
  if (!existsSync(path)) return c.json({ error: "subagent not found" }, 404);
  return c.json(parseStructuredTranscript(readFileSync(path, "utf-8")));
});
```
Append api.test.ts cases: `/sessions/:id` includes discovered subagents (fixture with a subagents dir); `/subagent/:sessionId/:agentId` returns the subagent transcript; 404s.

- [ ] **Step 5: Run tests**

Run: `bun test src/subagents.test.ts src/web/api/api.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/subagents.ts src/subagents.test.ts src/web/api/index.ts src/web/api/api.test.ts
git commit -m "feat(api): subagent discovery via .meta.json + endpoints"
```

---

### Task 4: Session list endpoint

**Files:**
- Modify: `src/web/api/index.ts` (`GET /api/sessions`)
- Test: `src/web/api/api.test.ts` (append)

**Interfaces:**
- `GET /api/sessions?limit&offset&project&q` → `{ sessions: {...}[]; total: number }` ordered by `started_at` desc.

- [ ] **Step 1: Write the failing test** — seed 3 sessions across 2 projects; assert list returns them newest-first with `total`, respects `limit`/`offset` and `project` filter, and each row has `id, project_id, display_name, started_at, message_count`.

- [ ] **Step 2: Run to verify it fails** — `bun test src/web/api/api.test.ts` (route 404).

- [ ] **Step 3: Implement:**
```ts
api.get("/sessions", (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") || "50", 10) || 50, 200);
  const offset = parseInt(c.req.query("offset") || "0", 10) || 0;
  const project = c.req.query("project");
  const where = project ? "WHERE s.project_id = ?" : "";
  const args = project ? [project] : [];
  const total = (db.query(`SELECT COUNT(*) c FROM sessions s ${where}`).get(...args) as { c:number }).c;
  const sessions = db.query(
    `SELECT s.id, s.project_id, p.display_name, s.started_at, s.ended_at, s.message_count, s.is_subagent
     FROM sessions s JOIN projects p ON p.id = s.project_id ${where}
     ORDER BY s.started_at DESC LIMIT ? OFFSET ?`
  ).all(...args, limit, offset);
  return c.json({ sessions, total });
});
```

- [ ] **Step 4: Run tests** — `bun test src/web/api/api.test.ts && bun run check` → PASS.

- [ ] **Step 5: Commit**
```bash
git add src/web/api/index.ts src/web/api/api.test.ts
git commit -m "feat(api): session list endpoint"
```

---

### Task 5: React data layer + session list view

**Files:**
- Create: `web/src/api.ts` (typed fetch helpers), `web/src/routes.tsx` (client router), `web/src/pages/SessionList.tsx`
- Modify: `web/src/App.tsx`, `web/src/main.tsx`
- Test: `web/src/pages/SessionList.test.tsx`

**Interfaces:**
- `web/src/api.ts` exports typed `getSessions`, `getSession`, `getTranscript`, `getSubagent` matching the API shapes from Tasks 2-4.

- [ ] **Step 1: Write the failing component test**

`web/src/pages/SessionList.test.tsx` — mock `fetch` (or the `api.ts` module) to return two sessions; render `<SessionList/>`; assert both titles/links appear and link to `/s/:id`.

- [ ] **Step 2: Run to verify it fails** — `cd web && bun x vitest run src/pages/SessionList.test.tsx` (component missing).

- [ ] **Step 3: Implement** `web/src/api.ts` (typed wrappers over `/api/...` with `StructuredMessage`/`Subagent` types mirrored from the backend), a small client router (React Router or a minimal hash/history router) with routes `/` → `SessionList`, `/s/:id` → `SessionDetail` (stub for now), and `SessionList.tsx` (fetch `getSessions`, render rows with Tailwind, link to `/s/:id`). Wire `main.tsx`/`App.tsx` to the router.

- [ ] **Step 4: Run tests** — `cd web && bun x vitest run` → PASS.

- [ ] **Step 5: Commit**
```bash
git add web/src
git commit -m "feat(react): typed API layer + session list view"
```

---

### Task 6: Session detail + viewer components + toggles

**Files:**
- Create: `web/src/pages/SessionDetail.tsx`, `web/src/components/{MessageBlock,ThinkingBlock,ToolCallBlock,SubagentPanel,Transcript}.tsx`, `web/src/toolPreview.ts`
- Test: `web/src/pages/SessionDetail.test.tsx`, `web/src/components/ToolCallBlock.test.tsx`

**Interfaces:**
- `Transcript({ messages, showThinking, showTools })` renders the message stream; `ToolCallBlock` collapsible with preview + paired result; `SubagentPanel` lazy-loads `/api/subagent/...`; `toolPreview(name, input)` per-tool one-liner (same table as before).

- [ ] **Step 1: Write the failing tests**

`ToolCallBlock.test.tsx`: given a tool_use block + its result, renders a collapsed `<details>` with tool name + preview; expanding shows input + result; hidden when `showTools` false.
`SessionDetail.test.tsx`: mock `getSession` (with one subagent) + `getTranscript` (text+thinking+tool_use+tool_result); assert default hides thinking/tools; toggling `Show thinking`/`Show tools` reveals them; a subagent panel appears and lazy-loads on expand (mock `getSubagent`); empty-state note when a shown kind is absent.

- [ ] **Step 2: Run to verify they fail** — `cd web && bun x vitest run` (components missing).

- [ ] **Step 3: Implement** the components:
  - `toolPreview.ts` — Read/Write/Edit→file_path, Bash→command≤80, Glob/Grep→pattern, Task→description, WebFetch→url, else "".
  - `ThinkingBlock` — bubble, `~round(len/4)` token estimate when >100 chars; rendered only when `showThinking`.
  - `ToolCallBlock` — `<details>` with `<summary>` = tool name + preview; body = `<pre>` input + paired result; rendered only when `showTools`. Receives the result via a `resultsByToolUseId` map built in `Transcript`.
  - `SubagentPanel` — collapsible; on first expand, `getSubagent(sessionId, agentId)` → renders nested `<Transcript>` (recursive), inheriting the toggle state.
  - `MessageBlock` — role + timestamp; text via `react-markdown` + `remark-gfm`.
  - `Transcript` — builds `resultsByToolUseId`, renders messages/blocks in order, respects toggles, renders subagent panels at their mapped `toolUseId` (via the session's subagents list), and shows dimension-specific empty-state notes.
  - `SessionDetail` — fetches session + transcript, holds `showThinking`/`showTools` state (default false) + the two toggle buttons, renders `<Transcript>`.

- [ ] **Step 4: Run tests** — `cd web && bun x vitest run` → PASS.

- [ ] **Step 5: Commit**
```bash
git add web/src
git commit -m "feat(react): session viewer — collapsible tools, thinking, subagents, toggles"
```

---

### Task 7: Full verification + live smoke

- [ ] **Step 1: Backend suite** — `bun run check` → all pass, typecheck clean.
- [ ] **Step 2: Frontend suite** — `cd web && bun x vitest run` → all pass.
- [ ] **Step 3: Prod build** — `cd web && bun run build` succeeds; `web/dist` produced.
- [ ] **Step 4: Live smoke** — start `engineering-notebook serve --react --port 3944`; open `/`, click a session with tools+thinking+subagents (e.g. the current dev session `f7a485a8-…`); verify: list loads; detail renders; **Show tools** reveals collapsible tools with previews + paired results; **Show thinking** reveals thinking (use a session known to have thinking text); a **subagent panel** lazy-loads and renders on expand. Record output. Kill the server.
- [ ] **Step 5: Commit any touch-ups (only if needed)**
```bash
git add -A && git commit -m "chore(react): finalize Phase 1 foundation"
```

---

## Self-Review

**Spec coverage:** monorepo `web/` + Hono `/api` + dev proxy/prod static (Task 1); structured transcript endpoint (Task 2); subagent discovery via `.meta.json` exact mapping + endpoints (Task 3); session list (Task 4); React data layer + list (Task 5); session viewer with collapsible tools, thinking, subagent nesting, client-side hide/show toggles + empty-state (Task 6); verification incl. prod build + live smoke (Task 7). Additive-only; legacy views/DB untouched. ✔

**Placeholder scan:** Backend tasks carry complete code. Frontend tasks (5-6) specify components, their contracts, and the exact tests to write; the React/Tailwind bodies are described precisely (props, behavior, per-tool preview, toggle defaults) rather than pasted in full — appropriate for generated-scaffold UI, with tests pinning behavior.

**Type consistency:** `StructuredMessage`/`StructuredBlock` (Task 2) are the transcript API contract consumed by `web/src/api.ts` (Task 5) and the viewer (Task 6). `Subagent` (Task 3) flows into `/api/sessions/:id` (Task 3) → `api.ts` → `SubagentPanel` (Task 6). `toolPreview`'s table matches the earlier server-side version. Route paths (`/api/sessions`, `/api/sessions/:id`, `/api/sessions/:id/transcript`, `/api/subagent/:sessionId/:agentId`) are consistent across Tasks 2-6.
