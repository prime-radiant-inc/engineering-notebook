# Transcript Visual Match (React viewer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the enriched session transcript read like the React viewer — collapsible tool calls with name + preview and paired results, thinking bubbles with a token estimate, teal-accented rounded styling.

**Architecture:** Enrich `TranscriptItem` with structured tool fields (`id`, `toolUseId`, `input`) in `src/transcript.ts`, then rework `renderTranscriptItems` in `src/web/views/session.ts` to render `<details>` tool blocks with previews and inline paired results and bubble-styled thinking, backed by new CSS in `src/web/views/layout.ts`. Default view, toggles, route, and fallback are untouched.

**Tech Stack:** Bun, bun:sqlite, Hono, TypeScript, server-rendered HTML, `bun test`. No new dependencies.

## Global Constraints

- Runtime **Bun**; verify with `bun run check`. Pre-commit hook runs `bun test` + typecheck.
- **No new dependencies.** No changes to ingest/storage/search/summary, nor to the default text-only view, the toggle controls (`toggleControls`), the `/session/:id` route, or the warning/fallback logic. Only the enriched-block rendering + its CSS change.
- The notebook is **light-only**; use existing warm-neutral tokens plus one new `--accent: #1a6b5a`.
- All dynamic content (tool name, preview, input, result, thinking) rendered through `escapeHtml`.
- Tool preview table: `Read`/`Write`/`Edit`→`file_path`; `Bash`→`command` (≤80 chars); `Glob`/`Grep`→`pattern`; `Task`→`description`; `WebFetch`→`url`; else `""`.
- Result pairing: a `tool_result` renders inside its matching `tool_use` (`tool_use.id === tool_result.tool_use_id`); orphans render standalone; each result consumed at most once.
- Thinking token estimate: `~round(len/4).toLocaleString() tokens` shown only when content length > 100.
- Tests assert real behavior; suite + typecheck green before each commit. Branch: `feature/session-groups`.

---

### Task 1: Enrich the transcript parser with structured tool fields

**Files:**
- Modify: `src/transcript.ts` (`TranscriptItem` type; `tool_use` and `tool_result` push branches)
- Test: `src/transcript.test.ts` (update two expectation lines; add one pairing test)

**Interfaces:**
- Produces: `TranscriptItem` gains optional `id?: string`, `toolUseId?: string`, `input?: Record<string, unknown>`.

- [ ] **Step 1: Update the test (RED)**

In `src/transcript.test.ts`, update the two expectation lines in the existing "parses claude blocks in order…" test to include the new additive fields (the fixture's `tool_use` has `input`, and its `tool_result` has `tool_use_id: "t1"`):

Change:
```ts
    { role: "assistant", kind: "tool_use", name: "Bash", content: JSON.stringify({ command: "ls" }, null, 2) },
    { role: "user", kind: "tool_result", content: "file-a\nfile-b" },
```
to:
```ts
    { role: "assistant", kind: "tool_use", name: "Bash", input: { command: "ls" }, content: JSON.stringify({ command: "ls" }, null, 2) },
    { role: "user", kind: "tool_result", toolUseId: "t1", content: "file-a\nfile-b" },
```

Add a new test for id/toolUseId capture:
```ts
test("captures tool_use id, structured input, and tool_result toolUseId", () => {
  const lines = [
    JSON.stringify({ type: "assistant", message: { content: [
      { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/x.ts" } },
    ] } }),
    JSON.stringify({ type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "tu_1", content: "ok" },
    ] } }),
  ].join("\n");
  const { items } = parseTranscript(lines);
  expect(items[0]).toEqual({ role: "assistant", kind: "tool_use", name: "Read", id: "tu_1", input: { file_path: "/x.ts" }, content: JSON.stringify({ file_path: "/x.ts" }, null, 2) });
  expect(items[1]).toEqual({ role: "user", kind: "tool_result", toolUseId: "tu_1", content: "ok" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/transcript.test.ts`
Expected: FAIL — items lack `input`/`toolUseId`/`id`.

- [ ] **Step 3: Implement in `src/transcript.ts`**

3a. Extend the `TranscriptItem` type:
```ts
export type TranscriptItem = {
  role: TranscriptRole;
  kind: TranscriptKind;
  content: string;
  name?: string;
  id?: string;
  toolUseId?: string;
  input?: Record<string, unknown>;
};
```

3b. Replace the `tool_use` case body:
```ts
        case "tool_use":
          items.push({
            role, kind: "tool_use",
            name: typeof b.name === "string" ? b.name : undefined,
            id: typeof b.id === "string" ? b.id : undefined,
            input: b.input != null && typeof b.input === "object" ? (b.input as Record<string, unknown>) : undefined,
            content: b.input != null ? JSON.stringify(b.input, null, 2) : "",
          });
          break;
```

3c. Replace the `tool_result` case body:
```ts
        case "tool_result":
          items.push({
            role, kind: "tool_result",
            toolUseId: typeof b.tool_use_id === "string" ? b.tool_use_id : undefined,
            content: toolResultToString(b.content),
          });
          break;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/transcript.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/transcript.ts src/transcript.test.ts
git commit -m "feat(session): capture tool id/input and tool_result id in transcript parser"
```

---

### Task 2: Rework enriched rendering (collapsible tools, previews, pairing, bubbles) + CSS

**Files:**
- Modify: `src/web/views/session.ts` (add `toolPreview`; rework `renderTranscriptItems`)
- Modify: `src/web/views/layout.ts` (add `--accent`; restyle `.transcript-thinking`/`.transcript-tool`; add `.tool-name`/`.tool-preview`/`.tool-result`/`.tokens`)
- Test: `src/web/views/session.test.ts` (append)

**Interfaces:**
- Produces: `export function toolPreview(name: string | undefined, input: Record<string, unknown> | undefined): string`.
- `renderTranscriptItems` now emits `<details class="transcript-tool">` for tool_use with a paired result inside; thinking as a bubble with token estimate.

- [ ] **Step 1: Write the failing test**

Append to the existing "session detail thinking/tools toggle" describe in `src/web/views/session.test.ts`:

```ts
test("tool call renders collapsible with name, preview, and paired result", () => {
  const src = join(tempDir, "tool.jsonl");
  writeFileSync(src, [
    JSON.stringify({ type: "assistant", message: { content: [
      { type: "tool_use", id: "tu_9", name: "Bash", input: { command: "ls -la /tmp" } },
    ] } }),
    JSON.stringify({ type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "tu_9", content: "RESULT_PAYLOAD" },
    ] } }),
  ].join("\n"));
  seedWithFile("s1", src);
  const html = renderSessionDetail(db, "s1", { showTools: true });
  expect(html).toContain("<details class=\"transcript-tool\"");
  expect(html).toContain("class=\"tool-name\">Bash");
  expect(html).toContain("ls -la /tmp");                     // preview + input
  expect(html).toContain("RESULT_PAYLOAD");                  // paired result present
  expect((html.match(/RESULT_PAYLOAD/g) || []).length).toBe(1); // not duplicated standalone
});

test("long thinking shows a token estimate", () => {
  const src = join(tempDir, "think.jsonl");
  const long = "x".repeat(400);
  writeFileSync(src, JSON.stringify({ type: "assistant", message: { content: [
    { type: "thinking", thinking: long },
  ] } }));
  seedWithFile("s1", src);
  const html = renderSessionDetail(db, "s1", { showThinking: true });
  expect(html).toContain("class=\"transcript-thinking\"");
  expect(html).toContain("tokens");
});

test("toolPreview returns per-tool one-liners", () => {
  expect(toolPreview("Bash", { command: "a".repeat(120) }).length).toBe(80);
  expect(toolPreview("Read", { file_path: "/a.ts" })).toBe("/a.ts");
  expect(toolPreview("Grep", { pattern: "foo" })).toBe("foo");
  expect(toolPreview("Task", { description: "do it" })).toBe("do it");
  expect(toolPreview("Unknown", { x: 1 })).toBe("");
  expect(toolPreview(undefined, undefined)).toBe("");
});
```

Add `toolPreview` to the import from `./session` at the top of the test file (alongside `renderSessionDetail`).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/web/views/session.test.ts`
Expected: FAIL — `toolPreview` not exported / old markup.

- [ ] **Step 3: Implement**

3a. In `src/web/views/session.ts`, add the exported helper (above `renderTranscriptItems`):

```ts
export function toolPreview(name: string | undefined, input: Record<string, unknown> | undefined): string {
  if (!name || !input) return "";
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  switch (name) {
    case "Read": case "Write": case "Edit": return s(input.file_path);
    case "Bash": return s(input.command).slice(0, 80);
    case "Glob": case "Grep": return s(input.pattern);
    case "Task": return s(input.description);
    case "WebFetch": return s(input.url);
    default: return "";
  }
}
```

3b. Replace the whole `renderTranscriptItems` function body with:

```ts
function renderTranscriptItems(items: TranscriptItem[], showThinking: boolean, showTools: boolean): string {
  const resultsByToolUseId = new Map<string, string>();
  for (const it of items) {
    if (it.kind === "tool_result" && it.toolUseId && !resultsByToolUseId.has(it.toolUseId)) {
      resultsByToolUseId.set(it.toolUseId, it.content);
    }
  }
  const consumed = new Set<string>();

  let html = "";
  let hadThinking = false;
  let hadTool = false;
  for (const item of items) {
    if (item.kind === "thinking") { hadThinking = true; if (!showThinking) continue; }
    if (item.kind === "tool_use" || item.kind === "tool_result") { hadTool = true; if (!showTools) continue; }

    if (item.kind === "text") {
      const who = item.role === "user" ? "User" : "Assistant";
      html += `<div style="margin-bottom:12px;"><div style="font-size:11px; color:var(--text-ghost);">${who}</div><div>${escapeHtml(item.content)}</div></div>`;
    } else if (item.kind === "thinking") {
      const tokens = item.content.length > 100
        ? `<span class="tokens">~${Math.round(item.content.length / 4).toLocaleString()} tokens</span>`
        : "";
      html += `<div class="transcript-thinking">${escapeHtml(item.content)}${tokens}</div>`;
    } else if (item.kind === "tool_use") {
      const preview = toolPreview(item.name, item.input);
      const body = escapeHtml(item.input ? JSON.stringify(item.input, null, 2) : item.content);
      let resultHtml = "";
      if (item.id && resultsByToolUseId.has(item.id)) {
        consumed.add(item.id);
        resultHtml = `<div class="tool-result"><pre>${escapeHtml(resultsByToolUseId.get(item.id)!)}</pre></div>`;
      }
      html += `<details class="transcript-tool"><summary><span class="tool-name">${escapeHtml(item.name || "tool")}</span>` +
        (preview ? `<span class="tool-preview">${escapeHtml(preview)}</span>` : "") +
        `</summary><pre>${body}</pre>${resultHtml}</details>`;
    } else { // tool_result
      if (item.toolUseId && consumed.has(item.toolUseId)) continue; // already shown inside its tool_use
      html += `<div class="transcript-tool" style="display:block;"><div style="font-weight:600; color:var(--text-muted);">&#8627; result</div><pre>${escapeHtml(item.content)}</pre></div>`;
    }
  }

  if (showThinking && !hadThinking) {
    html += `<div style="color:var(--text-ghost); font-style:italic; font-size:12px;">No thinking data for this session.</div>`;
  }
  if (showTools && !hadTool) {
    html += `<div style="color:var(--text-ghost); font-style:italic; font-size:12px;">No tool data for this session.</div>`;
  }
  return html;
}
```

3c. `src/web/views/layout.ts` — add `--accent: #1a6b5a;` inside `:root` (after `--text-ghost`), and replace the existing transcript CSS block (`.transcript-thinking`/`.transcript-tool`/`.transcript-tool pre`, added in the prior feature) with:

```css
    .transcript-thinking { background:var(--surface); border-radius:14px 14px 14px 4px; padding:10px 14px; margin:8px 0; color:var(--text-muted); font-style:italic; font-size:12px; white-space:pre-wrap; }
    .transcript-thinking .tokens { display:block; text-align:right; font-size:10px; color:var(--text-ghost); font-style:normal; margin-top:6px; }
    details.transcript-tool { border:1px solid var(--border); border-radius:10px; padding:6px 10px; margin:8px 0; font-size:12px; }
    details.transcript-tool > summary { cursor:pointer; list-style:none; color:var(--text-muted); }
    details.transcript-tool > summary::-webkit-details-marker { display:none; }
    .transcript-tool .tool-name { color:var(--accent); font-weight:600; font-family:var(--font-sans); }
    .transcript-tool .tool-preview { color:var(--text-faint); margin-left:8px; font-family:monospace; }
    .transcript-tool pre { white-space:pre-wrap; margin:6px 0 0; font-family:monospace; font-size:11px; }
    .transcript-tool .tool-result { border-top:1px solid var(--border-subtle); margin-top:6px; padding-top:6px; }
```

Keep the existing `.transcript-toggle` and `.transcript-warning` rules unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/web/views/session.test.ts && bun run check`
Expected: PASS (new tests + the existing thinking/tools tests, which still hold: showTools output still contains "Bash" and the command text; showThinking still renders no tool markup).

- [ ] **Step 5: Commit**

```bash
git add src/web/views/session.ts src/web/views/layout.ts src/web/views/session.test.ts
git commit -m "feat(session): collapsible tool calls, thinking bubbles, teal accent styling"
```

---

### Task 3: Full suite green + live visual smoke

**Files:** verification only.

- [ ] **Step 1: Full suite + typecheck**

Run: `bun run check`
Expected: all pass; `All checks passed.`

- [ ] **Step 2: Live smoke on a session with many tools + thinking**

```bash
engineering-notebook serve --port 3943 &
sleep 1
SID=66f8e01a-8eb0-44f1-adc7-b6748914e727
curl -s "http://localhost:3943/session/$SID?tools=1"    | grep -o '<details class="transcript-tool"' | wc -l   # collapsible tools present
curl -s "http://localhost:3943/session/$SID?tools=1"    | grep -o 'class="tool-name"' | head -1
curl -s "http://localhost:3943/session/$SID?thinking=1" | grep -o 'class="tokens"' | head -1                  # token estimate present
kill %1
```
Expected: a non-zero count of `<details class="transcript-tool"`; `tool-name` present; `tokens` present. Confirm in a browser that tools are collapsed by default and expand on click, with the result shown inside. Record output.

- [ ] **Step 3: Commit any touch-ups (only if Steps 1-2 surfaced a fix)**

```bash
git add -A
git commit -m "chore(session): finalize transcript visual match"
```

---

## Self-Review

**Spec coverage:**
- Collapsible tools (`<details>`, name + preview, expand for input) → Task 2. ✔
- Tool preview table → Task 2 `toolPreview`. ✔
- Result paired inside its tool_use; orphans standalone; consumed once → Task 2 (map + `consumed` set). ✔
- Thinking bubble + token estimate (>100 chars) → Task 2. ✔
- Teal accent + rounded styling on light tokens → Task 2 CSS (`--accent`). ✔
- Parser carries `id`/`toolUseId`/`input` → Task 1. ✔
- Text unchanged; escaping preserved; default/toggles/route/fallback untouched → Tasks 1-2 touch only the parser fields + `renderTranscriptItems` + CSS. ✔
- No new deps, no ingest/storage changes → confirmed by touched files. ✔

**Placeholder scan:** No TBD/TODO; every code step has full code; test steps show assertions.

**Type consistency:** `TranscriptItem`'s new optional fields (Task 1) are read in Task 2 (`item.id`, `item.input`, `item.toolUseId`). `toolPreview(name, input)` signature in Task 2's impl matches its test calls and its use in `renderTranscriptItems`. CSS class names added in Task 2c (`transcript-thinking`, `.tokens`, `transcript-tool`, `.tool-name`, `.tool-preview`, `.tool-result`) match exactly the class strings emitted by Task 2b's render code.
