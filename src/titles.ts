import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { defaultSessionsDir } from "./desktop-groups";

const TITLE_MODEL = "claude-haiku-4-5-20251001";

export type DesktopTitle = { cliSessionId: string; title: string; source: "desktop" | "user" };

/** Read Claude Desktop's per-session titles (from local_<uuid>.json), keyed by notebook session id (cliSessionId). */
export function readDesktopTitles(sessionsDir: string = defaultSessionsDir()): DesktopTitle[] {
  const out: DesktopTitle[] = [];
  if (!existsSync(sessionsDir)) return out;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && entry.name.startsWith("local_") && entry.name.endsWith(".json")) {
        try {
          const d = JSON.parse(readFileSync(p, "utf-8"));
          if (typeof d.cliSessionId === "string" && typeof d.title === "string" && d.title.trim()) {
            out.push({ cliSessionId: d.cliSessionId, title: d.title.trim(), source: d.titleSource === "user" ? "user" : "desktop" });
          }
        } catch {
          /* skip unreadable */
        }
      }
    }
  };
  walk(sessionsDir);
  return out;
}

/** Apply Desktop titles onto notebook sessions. Desktop/user titles win over generated ones. */
export function applyDesktopTitles(db: Database, titles: DesktopTitle[] = readDesktopTitles()): number {
  let applied = 0;
  const tx = db.transaction(() => {
    for (const t of titles) {
      const res = db.query(
        `UPDATE sessions SET title = ?, title_source = ?
         WHERE id = ? AND (title IS NULL OR title_source = 'generated' OR title_source IS NULL OR ? = 'user')`
      ).run(t.title, t.source, t.cliSessionId, t.source);
      if (res.changes > 0) applied++;
    }
  });
  tx();
  return applied;
}

/** Generate a short Desktop-style title from a session's conversation text. */
export async function generateTitle(conversationMarkdown: string): Promise<string> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const snippet = conversationMarkdown.slice(0, 6000);
  const prompt = `Below is a coding-assistant session transcript. Write a concise title of 3-8 words that names what the session is about, in the style of an app's auto-generated chat title. Output ONLY the title — no quotes, no trailing punctuation, no preamble.\n\n---\n${snippet}\n---\n\nTitle:`;

  const env = { ...process.env };
  delete env.CLAUDECODE;

  let text = "";
  const result = query({
    prompt,
    options: { model: TITLE_MODEL, maxTurns: 1, tools: [], permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, persistSession: false, env },
  });
  for await (const message of result) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if ("text" in block && typeof block.text === "string") text += block.text;
      }
    }
  }
  // First non-empty line, stripped of surrounding quotes/trailing punctuation.
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) || "";
  return line.replace(/^["'`]+|["'`]+$/g, "").replace(/[.\s]+$/, "").slice(0, 120);
}

/** Generate + store a title for one session that lacks one. Returns the title (or null if no content). */
export async function titleSession(db: Database, sessionId: string): Promise<string | null> {
  const row = db.query(
    `SELECT c.conversation_markdown AS md FROM sessions s LEFT JOIN conversations c ON c.session_id = s.id WHERE s.id = ?`
  ).get(sessionId) as { md: string | null } | null;
  if (!row || !row.md || !row.md.trim()) return null;
  const title = await generateTitle(row.md);
  if (!title) return null;
  db.query("UPDATE sessions SET title = ?, title_source = 'generated' WHERE id = ?").run(title, sessionId);
  return title;
}

/** Backfill generated titles for sessions with no title (skips Desktop/user-titled ones). */
export async function backfillTitles(db: Database, opts: { limit?: number; onProgress?: (done: number, total: number, title: string) => void } = {}): Promise<{ generated: number; skipped: number }> {
  const rows = db.query(
    `SELECT s.id FROM sessions s
     WHERE (s.title IS NULL OR s.title = '')
       AND COALESCE(s.is_subagent, 0) = 0
       AND EXISTS (SELECT 1 FROM conversations c WHERE c.session_id = s.id AND c.conversation_markdown != '')
     ORDER BY s.started_at DESC ${opts.limit ? "LIMIT " + Math.max(0, opts.limit | 0) : ""}`
  ).all() as { id: string }[];
  let generated = 0, skipped = 0;
  for (let i = 0; i < rows.length; i++) {
    try {
      const t = await titleSession(db, rows[i]!.id);
      if (t) { generated++; opts.onProgress?.(i + 1, rows.length, t); }
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { generated, skipped };
}
