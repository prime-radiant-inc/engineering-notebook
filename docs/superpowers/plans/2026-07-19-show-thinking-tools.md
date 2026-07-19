# Show / Hide Thinking & Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a reader show/hide Thinking and Tool content on the `/session/:id` display, by re-parsing the original JSONL on demand; default stays the clean text-only view.

**Architecture:** A new pure `src/transcript.ts` parses a session's raw JSONL into ordered `TranscriptItem`s (text/thinking/tool_use/tool_result). `renderSessionDetail` gains `{ showThinking, showTools }`: when either is set it reads `source_path`, parses it, and renders the enriched transcript (warning + text-only fallback if the file is unavailable); otherwise it renders the stored markdown exactly as today. `GET /session/:id` reads `thinking`/`tools` query params. Toggle controls are query-param links.

**Tech Stack:** Bun, bun:sqlite, Hono, TypeScript, server-rendered HTML strings, `bun test`.

## Global Constraints

- Runtime **Bun**; verify with `bun run check` (`bun test` + `bun --bun tsc --noEmit`). Pre-commit hook runs both. No new dependencies.
- **Default behavior is unchanged:** with no params, `renderSessionDetail` renders the stored `conversation_markdown` and reads no file.
- Re-parse happens **only** when `showThinking || showTools`. Source of the JSONL is the session's `source_path`.
- **Fallback:** if a show flag is set but `source_path` is missing/unreadable → render a warning banner ("Original session file unavailable — can't show thinking/tools") then the text-only view; controls still render.
- **Claude Code JSONL block shapes** (verified against the real store): records `{ type: "user"|"assistant", message: { content } }`; `content` is a string or an array of blocks — `{type:"text",text}`, `{type:"thinking",thinking}`, `{type:"tool_use",name,input}` (input is an object), `{type:"tool_result",tool_use_id,content}` (content is a string or an array of `{type:"text",text}`).
- **Codex JSONL:** records `{type:"session_meta"}` (skip) and `{type:"response_item", payload:{ type:"message", role, content:[{type:"input_text"|"output_text",text}] }}` — text only; no thinking/tool data. When a show flag is set and the parsed items contain no thinking/tool items, render a muted "No thinking/tool data for this session." note.
- All content rendered through `escapeHtml`. Scope is the dedicated `/session/:id` view only (do not modify the inline three-panel session panel behavior).
- Tests assert real behavior; suite + typecheck green before each commit. Branch: `feature/session-groups`.

---

### Task 1: Transcript parser — `src/transcript.ts`

**Files:**
- Create: `src/transcript.ts`
- Test: `src/transcript.test.ts`

**Interfaces:**
- Produces:
  - `type TranscriptRole = "user" | "assistant"`
  - `type TranscriptKind = "text" | "thinking" | "tool_use" | "tool_result"`
  - `type TranscriptItem = { role: TranscriptRole; kind: TranscriptKind; content: string; name?: string }`
  - `type TranscriptFormat = "claude" | "codex" | "unknown"`
  - `parseTranscript(jsonlText: string): { items: TranscriptItem[]; format: TranscriptFormat }`

- [ ] **Step 1: Write the failing test**

Create `src/transcript.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { parseTranscript } from "./transcript";

const claudeLines = [
  JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "hi" }] } }),
  JSON.stringify({ type: "assistant", message: { content: [
    { type: "thinking", thinking: "let me think" },
    { type: "text", text: "answer" },
    { type: "tool_use", name: "Bash", input: { command: "ls" } },
  ] } }),
  JSON.stringify({ type: "user", message: { content: [
    { type: "tool_result", tool_use_id: "t1", content: "file-a\nfile-b" },
  ] } }),
  "",
  "{ not json",
].join("\n");

describe("parseTranscript", () => {
  test("parses claude blocks in order with kinds/roles/names", () => {
    const { items, format } = parseTranscript(claudeLines);
    expect(format).toBe("claude");
    expect(items).toEqual([
      { role: "user", kind: "text", content: "hi" },
      { role: "assistant", kind: "thinking", content: "let me think" },
      { role: "assistant", kind: "text", content: "answer" },
      { role: "assistant", kind: "tool_use", name: "Bash", content: JSON.stringify({ command: "ls" }, null, 2) },
      { role: "user", kind: "tool_result", content: "file-a\nfile-b" },
    ]);
  });

  test("tool_result with array content joins text blocks", () => {
    const line = JSON.stringify({ type: "user", message: { content: [
      { type: "tool_result", content: [{ type: "text", text: "line1" }, { type: "text", text: "line2" }] },
    ] } });
    const { items } = parseTranscript(line);
    expect(items[0]).toEqual({ role: "user", kind: "tool_result", content: "line1\nline2" });
  });

  test("string message content becomes a single text item", () => {
    const line = JSON.stringify({ type: "assistant", message: { content: "plain" } });
    expect(parseTranscript(line).items).toEqual([{ role: "assistant", kind: "text", content: "plain" }]);
  });

  test("codex records parse to text-only items", () => {
    const lines = [
      JSON.stringify({ type: "session_meta", payload: { id: "x" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "u" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "a" }] } }),
    ].join("\n");
    const { items, format } = parseTranscript(lines);
    expect(format).toBe("codex");
    expect(items).toEqual([
      { role: "user", kind: "text", content: "u" },
      { role: "assistant", kind: "text", content: "a" },
    ]);
  });

  test("empty input → no items, unknown format", () => {
    expect(parseTranscript("")).toEqual({ items: [], format: "unknown" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/transcript.test.ts`
Expected: FAIL — `Cannot find module './transcript'`.

- [ ] **Step 3: Implement `src/transcript.ts`**

```ts
export type TranscriptRole = "user" | "assistant";
export type TranscriptKind = "text" | "thinking" | "tool_use" | "tool_result";
export type TranscriptItem = { role: TranscriptRole; kind: TranscriptKind; content: string; name?: string };
export type TranscriptFormat = "claude" | "codex" | "unknown";

function toolResultToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && typeof (b as any).text === "string" ? (b as any).text : JSON.stringify(b)))
      .join("\n");
  }
  if (content == null) return "";
  return JSON.stringify(content, null, 2);
}

export function parseTranscript(jsonlText: string): { items: TranscriptItem[]; format: TranscriptFormat } {
  const items: TranscriptItem[] = [];
  let format: TranscriptFormat = "unknown";

  for (const line of jsonlText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: any;
    try { rec = JSON.parse(trimmed); } catch { continue; }

    // Codex format
    if (rec?.type === "session_meta") { format = "codex"; continue; }
    if (rec?.type === "response_item") {
      const p = rec.payload;
      if (p?.type !== "message" || (p.role !== "user" && p.role !== "assistant")) continue;
      format = "codex";
      const role = p.role as TranscriptRole;
      for (const b of Array.isArray(p.content) ? p.content : []) {
        if ((b?.type === "input_text" || b?.type === "output_text") && typeof b.text === "string" && b.text && b.text !== "(no content)") {
          items.push({ role, kind: "text", content: b.text });
        }
      }
      continue;
    }

    // Claude Code format
    if (rec?.type !== "user" && rec?.type !== "assistant") continue;
    const role = rec.type as TranscriptRole;
    const content = rec?.message?.content;
    if (typeof content === "string") {
      if (content && content !== "(no content)") { items.push({ role, kind: "text", content }); if (format === "unknown") format = "claude"; }
      continue;
    }
    if (!Array.isArray(content)) continue;
    if (format === "unknown") format = "claude";

    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      switch (b.type) {
        case "text":
          if (typeof b.text === "string" && b.text && b.text !== "(no content)") items.push({ role, kind: "text", content: b.text });
          break;
        case "thinking":
          if (typeof b.thinking === "string" && b.thinking) items.push({ role, kind: "thinking", content: b.thinking });
          break;
        case "tool_use":
          items.push({
            role, kind: "tool_use",
            name: typeof b.name === "string" ? b.name : undefined,
            content: b.input != null ? JSON.stringify(b.input, null, 2) : "",
          });
          break;
        case "tool_result":
          items.push({ role, kind: "tool_result", content: toolResultToString(b.content) });
          break;
      }
    }
  }

  return { items, format };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/transcript.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/transcript.ts src/transcript.test.ts
git commit -m "feat(session): add transcript parser (text/thinking/tool blocks)"
```

---

### Task 2: Enriched session render + toggle controls + styles

**Files:**
- Modify: `src/web/views/session.ts` (`renderSessionDetail` gains opts; add `renderTranscriptItems`, toggle controls, warning + fallback)
- Modify: `src/web/views/layout.ts` (CSS classes `.transcript-thinking`, `.transcript-tool`, `.transcript-warning`, `.transcript-toggle`)
- Test: `src/web/views/session.test.ts` (append)

**Interfaces:**
- Consumes: `parseTranscript`, `TranscriptItem` from `../../transcript`; `escapeHtml`; `readFileSync`/`existsSync` from `fs`.
- Produces: `renderSessionDetail(db, sessionId, opts?: { showThinking?: boolean; showTools?: boolean }): string` (opts optional → current behavior).

- [ ] **Step 1: Write the failing test**

Append to `src/web/views/session.test.ts` (it already has DB-backed tests + imports from Task-6 of the prior feature; add these imports if missing: `writeFileSync`, `mkdtempSync`, `rmSync`, `tmpdir`, `join`). Add a new describe:

```ts
describe("session detail thinking/tools toggle", () => {
  let tempDir: string;
  let db: ReturnType<typeof initDb>;

  const jsonl = [
    JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "the question" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [
      { type: "thinking", thinking: "SECRET_REASONING" },
      { type: "text", text: "the answer" },
      { type: "tool_use", name: "Bash", input: { command: "ls" } },
    ] } }),
  ].join("\n");

  function seedWithFile(id: string, sourcePath: string) {
    db.query("INSERT OR IGNORE INTO projects (id, path, display_name) VALUES ('p','/tmp/p','P')").run();
    db.query(
      `INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at)
       VALUES (?, 'p', '/tmp/p', ?, '2026-07-10T00:00:00Z', 2, datetime('now'))`
    ).run(id, sourcePath);
    db.query("INSERT INTO conversations (session_id, conversation_markdown, extracted_at) VALUES (?, '# md the answer', datetime('now'))").run(id);
  }

  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), "tt-test-")); db = initDb(join(tempDir, "t.db")); });
  afterEach(() => { closeDb(); rmSync(tempDir, { recursive: true, force: true }); });

  test("default render shows toggle controls and no thinking/tool content", () => {
    const src = join(tempDir, "s.jsonl"); writeFileSync(src, jsonl);
    seedWithFile("s1", src);
    const html = renderSessionDetail(db, "s1");
    expect(html).toContain("Show thinking");
    expect(html).toContain("Show tools");
    expect(html).not.toContain("SECRET_REASONING");
  });

  test("showThinking re-parses the file and renders thinking; control flips to Hide", () => {
    const src = join(tempDir, "s.jsonl"); writeFileSync(src, jsonl);
    seedWithFile("s1", src);
    const html = renderSessionDetail(db, "s1", { showThinking: true });
    expect(html).toContain("SECRET_REASONING");
    expect(html).toContain("Hide thinking");
    expect(html).not.toContain('"input"'); // tools not shown
    expect(html).not.toContain("ls"); // tool input not shown
  });

  test("showTools renders tool call, not thinking", () => {
    const src = join(tempDir, "s.jsonl"); writeFileSync(src, jsonl);
    seedWithFile("s1", src);
    const html = renderSessionDetail(db, "s1", { showTools: true });
    expect(html).toContain("Bash");
    expect(html).toContain("ls");
    expect(html).not.toContain("SECRET_REASONING");
  });

  test("missing source file → warning banner + text-only fallback", () => {
    seedWithFile("s1", join(tempDir, "gone.jsonl")); // never written
    const html = renderSessionDetail(db, "s1", { showThinking: true });
    expect(html).toContain("Original session file unavailable");
    expect(html).not.toContain("SECRET_REASONING");
    expect(html).toContain("Hide thinking"); // control still shown
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/web/views/session.test.ts`
Expected: FAIL — opts ignored / no toggle controls.

- [ ] **Step 3: Implement**

3a. `src/web/views/session.ts` — add imports at the top:

```ts
import { existsSync, readFileSync } from "fs";
import { parseTranscript, type TranscriptItem } from "../../transcript";
```

3b. Add a helper that builds the toggle-control HTML and the transcript body. Insert before `renderSessionDetail`:

```ts
function toggleControls(sessionId: string, showThinking: boolean, showTools: boolean): string {
  const url = (t: boolean, o: boolean) => {
    const params: string[] = [];
    if (t) params.push("thinking=1");
    if (o) params.push("tools=1");
    return `/session/${encodeURIComponent(sessionId)}${params.length ? "?" + params.join("&") : ""}`;
  };
  const thinkingLink = url(!showThinking, showTools);
  const toolsLink = url(showThinking, !showTools);
  return (
    `<div class="transcript-toggle">` +
    `<a href="${thinkingLink}">${showThinking ? "Hide thinking" : "Show thinking"}</a>` +
    `<a href="${toolsLink}">${showTools ? "Hide tools" : "Show tools"}</a>` +
    `</div>`
  );
}

function renderTranscriptItems(items: TranscriptItem[], showThinking: boolean, showTools: boolean): string {
  let html = "";
  let hadThinking = false;
  let hadTool = false;
  for (const item of items) {
    if (item.kind === "thinking") { hadThinking = true; if (!showThinking) continue; }
    if (item.kind === "tool_use" || item.kind === "tool_result") { hadTool = true; if (!showTools) continue; }
    const who = item.role === "user" ? "User" : "Assistant";
    if (item.kind === "text") {
      html += `<div style="margin-bottom:12px;"><div style="font-size:11px; color:var(--text-ghost);">${who}</div><div>${escapeHtml(item.content)}</div></div>`;
    } else if (item.kind === "thinking") {
      html += `<div class="transcript-thinking">${escapeHtml(item.content)}</div>`;
    } else if (item.kind === "tool_use") {
      html += `<div class="transcript-tool"><div style="font-weight:600;">🛠 ${escapeHtml(item.name || "tool")}</div><pre>${escapeHtml(item.content)}</pre></div>`;
    } else {
      html += `<div class="transcript-tool"><div style="font-weight:600;">↳ result</div><pre>${escapeHtml(item.content)}</pre></div>`;
    }
  }
  if ((showThinking && !hadThinking) || (showTools && !hadTool)) {
    html += `<div style="color:var(--text-ghost); font-style:italic; font-size:12px;">No thinking/tool data for this session.</div>`;
  }
  return html;
}
```

3c. Change `renderSessionDetail`'s signature and body. Replace the current signature line and the conversation-body section:

```ts
export function renderSessionDetail(
  db: Database,
  sessionId: string,
  opts: { showThinking?: boolean; showTools?: boolean } = {}
): string {
```

After the existing metadata-header block (the `</div>` that closes the header, before the `if (session.conversation_markdown)` block), insert the toggle controls and, when a flag is set, the enriched body:

```ts
  const showThinking = opts.showThinking ?? false;
  const showTools = opts.showTools ?? false;
  html += toggleControls(sessionId, showThinking, showTools);

  if (showThinking || showTools) {
    if (session.source_path && existsSync(session.source_path)) {
      try {
        const { items } = parseTranscript(readFileSync(session.source_path, "utf-8"));
        html += renderTranscriptItems(items, showThinking, showTools);
        html += renderSessionFooter(sessionId, session.project_path, session.source_path);
        return html;
      } catch {
        html += `<div class="transcript-warning">Original session file unavailable — can't show thinking/tools.</div>`;
      }
    } else {
      html += `<div class="transcript-warning">Original session file unavailable — can't show thinking/tools.</div>`;
    }
    // fall through to text-only render below
  }
```

Leave the existing `if (session.conversation_markdown) { ... } else { ... }` text render and the final `renderSessionFooter(...)` call as the default/fallback path.

3d. `src/web/views/layout.ts` — add CSS near the other view styles (before the closing `</style>`):

```css
    .transcript-toggle { display:flex; gap:12px; margin-bottom:14px; font-size:12px; }
    .transcript-thinking { border-left:2px solid var(--border-subtle); padding:6px 10px; margin:8px 0; color:var(--text-muted); font-style:italic; white-space:pre-wrap; }
    .transcript-tool { border:1px solid var(--border-subtle); border-radius:4px; padding:8px 10px; margin:8px 0; font-family:monospace; font-size:12px; }
    .transcript-tool pre { white-space:pre-wrap; margin:4px 0 0; }
    .transcript-warning { color:#b91c1c; font-size:12px; margin:8px 0; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/web/views/session.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/views/session.ts src/web/views/layout.ts src/web/views/session.test.ts
git commit -m "feat(session): render thinking/tools on demand with toggle controls"
```

---

### Task 3: Route — `GET /session/:id` reads toggle params

**Files:**
- Modify: `src/web/server.ts` (`GET /session/:id` handler, near line 75)
- Test: `src/web/server.test.ts` (append)

**Interfaces:**
- Consumes: `renderSessionDetail(db, sessionId, { showThinking, showTools })`.

- [ ] **Step 1: Write the failing test**

Add to `src/web/server.test.ts`:

```ts
describe("session toggle route", () => {
  function seedWithFile(id: string, sourcePath: string) {
    db.query("INSERT OR IGNORE INTO projects (id, path, display_name) VALUES ('p','/tmp/p','P')").run();
    db.query(
      `INSERT INTO sessions (id, project_id, project_path, source_path, started_at, message_count, ingested_at)
       VALUES (?, 'p', '/tmp/p', ?, '2026-07-10T00:00:00Z', 2, datetime('now'))`
    ).run(id, sourcePath);
    db.query("INSERT INTO conversations (session_id, conversation_markdown, extracted_at) VALUES (?, '# md', datetime('now'))").run(id);
  }

  test("?thinking=1 renders thinking; no param does not", async () => {
    const { writeFileSync } = await import("fs");
    const src = join(tempDir, "sess.jsonl");
    writeFileSync(src, JSON.stringify({ type: "assistant", message: { content: [
      { type: "thinking", thinking: "SECRET_REASONING" }, { type: "text", text: "a" },
    ] } }));
    seedWithFile("s1", src);
    const app = createApp(db, syncManager);

    const on = await app.request("/session/s1?thinking=1");
    expect(on.status).toBe(200);
    expect(await on.text()).toContain("SECRET_REASONING");

    const off = await app.request("/session/s1");
    expect(await off.text()).not.toContain("SECRET_REASONING");
  });
});
```

(`tempDir` is the server test's per-test temp dir from its existing `beforeEach`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/web/server.test.ts`
Expected: FAIL — params ignored.

- [ ] **Step 3: Implement in `src/web/server.ts`**

In the `app.get("/session/:id", ...)` handler, read the params and pass them:

```ts
  app.get("/session/:id", (c) => {
    const sessionId = c.req.param("id");
    const showThinking = c.req.query("thinking") === "1";
    const showTools = c.req.query("tools") === "1";
    const panel3 = renderSessionDetail(db, sessionId, { showThinking, showTools });
    // ... rest of the handler unchanged (date lookup, panel1, panel2, layout) ...
```

Leave the remainder of the handler (date lookup for the index, `panel1`, `panel2`, `renderLayout` call) exactly as-is.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/web/server.test.ts && bun run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/server.ts src/web/server.test.ts
git commit -m "feat(session): wire thinking/tools query params into /session/:id"
```

---

### Task 4: Full suite green + live smoke check

**Files:** verification only.

- [ ] **Step 1: Full suite + typecheck**

Run: `bun run check`
Expected: all pass; `All checks passed.`

- [ ] **Step 2: Live smoke against a real session**

```bash
engineering-notebook serve --port 3942 &
sleep 1
SID=$(bun -e 'import{Database}from"bun:sqlite";import{homedir}from"os";import{join}from"path";const db=new Database(join(homedir(),".config/engineering-notebook/notebook.db"),{readonly:true});const r=db.query("SELECT id FROM sessions WHERE source_path LIKE ? ORDER BY started_at DESC LIMIT 1").get("%/.claude/projects/%");console.log(r.id)')
echo "session: $SID"
curl -s "http://localhost:3942/session/$SID"            | grep -o "Show thinking" | head -1   # default: control present
curl -s "http://localhost:3942/session/$SID?thinking=1" | grep -o "Hide thinking" | head -1   # toggled on
curl -s -o /dev/null -w "thinking=%{http_code} tools=%{http_code}\n" "http://localhost:3942/session/$SID?thinking=1&tools=1"
kill %1
```
Expected: default page shows "Show thinking"; `?thinking=1` shows "Hide thinking"; both-params request returns 200. Confirm in a browser that thinking/tool blocks actually appear when toggled. Record output.

- [ ] **Step 3: Commit any touch-ups (only if Steps 1-2 surfaced a fix)**

```bash
git add -A
git commit -m "chore(session): finalize thinking/tools toggle"
```

---

## Self-Review

**Spec coverage:**
- Default text-only, no file read → Task 2 (enriched path gated on flags). ✔
- Two independent controls, hidden by default, query-param links preserving the other param → Task 2 `toggleControls`. ✔
- Re-parse `source_path` on show → Task 2. ✔
- Warning + text-only fallback on missing/unreadable file → Task 2 (both `!existsSync` and try/catch paths). ✔
- Claude blocks (text/thinking/tool_use/tool_result, incl. array tool_result) → Task 1. ✔
- Codex → text + "No thinking/tool data" note → Task 1 (`format`/text-only) + Task 2 (note when requested-but-absent). ✔
- Route reads `thinking`/`tools` params → Task 3. ✔
- Scope limited to `/session/:id`; inline three-panel unchanged → Tasks 2/3 touch only `renderSessionDetail` + its route. ✔
- All content `escapeHtml`-ed → Task 2. ✔
- No ingest/schema/search/summary changes → confirmed by touched files. ✔

**Placeholder scan:** No TBD/TODO; every code step has full code; test steps show assertions.

**Type consistency:** `TranscriptItem`/`parseTranscript` defined in Task 1 are consumed unchanged in Task 2. `renderSessionDetail(db, id, { showThinking, showTools })` signature in Task 2 matches the call in Task 3. `.transcript-thinking`/`.transcript-tool`/`.transcript-warning`/`.transcript-toggle` classes added in Task 2's CSS match the class names emitted by Task 2's render helpers. Query-param names (`thinking`, `tools`) match between Task 2's link builder and Task 3's route reader.
