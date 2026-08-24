import { readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { Database } from "bun:sqlite";
import { parseSession } from "./parser";

/** Scan source directories for .jsonl session files, applying exclude patterns */
export function scanSources(
  sources: string[],
  exclude: string[]
): string[] {
  const files: string[] = [];
  const isExcluded = (name: string): boolean =>
    exclude.some((pattern) => {
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(
        "^" + escaped.replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
      );
      return regex.test(name);
    });

  for (const source of sources) {
    const stack = [source];

    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = join(dir, entry);
        let stat;
        try {
          stat = statSync(fullPath);
        } catch {
          continue;
        }

        if (stat.isDirectory()) {
          const relPath = relative(source, fullPath);
          if (isExcluded(entry) || isExcluded(relPath)) continue;
          stack.push(fullPath);
          continue;
        }

        if (entry.endsWith(".jsonl")) {
          files.push(fullPath);
        }
      }
    }
  }

  return files;
}

/** Ingest session files into the database */
export function ingestSessions(
  files: string[],
  db: Database,
  force = false
): { ingested: number; skipped: number; errors: string[] } {
  let ingested = 0;
  let skipped = 0;
  const errors: string[] = [];

  const checkStmt = db.query(
    "SELECT id, ingested_at FROM sessions WHERE source_path = ?"
  );
  const checkSessionId = db.query("SELECT id FROM sessions WHERE id = ?");
  const insertProject = db.prepare(`
    INSERT INTO projects (id, path, display_name, session_count)
    VALUES (?, ?, ?, 0)
    ON CONFLICT(id) DO UPDATE SET path = excluded.path
  `);
  const insertSession = db.prepare(`
    INSERT INTO sessions (id, parent_session_id, project_id, project_path, source_path, started_at, ended_at, git_branch, version, message_count, is_subagent, ingested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const insertConvo = db.prepare(`
    INSERT INTO conversations (session_id, conversation_markdown, extracted_at)
    VALUES (?, ?, datetime('now'))
  `);
  const deleteConvo = db.prepare(`DELETE FROM conversations WHERE session_id = ?`);
  const deleteSession = db.prepare(`DELETE FROM sessions WHERE id = ?`);

  for (const file of files) {
    /*
     * A file already seen is read again when it has grown since, and its session
     * replaced.
     *
     * A session's transcript is appended to for as long as the session is open, so
     * the same path holds more every day it stays open. Skipping on the path alone
     * froze a session at whatever length it happened to be the first night it was
     * scanned: one session here was stored at 195 messages from a file that had
     * reached 16,379 lines five days later, and every day of that work was missing
     * from the journal while the run reported no errors.
     */
    let replacing = force;
    if (!force) {
      const existing = checkStmt.get(file) as
        | { id: string; ingested_at: string }
        | undefined;
      if (existing) {
        /* datetime('now') writes UTC without a zone, so say so before parsing. It also
         * writes whole seconds, so the file's own time is compared at that resolution:
         * millisecond against second reads a file written in the same second as its
         * ingest as newer than it, and re-reads every such file for ever. */
        const seenAt = Date.parse(existing.ingested_at.replace(" ", "T") + "Z");
        const changedAt = Math.floor(statSync(file).mtimeMs / 1000) * 1000;
        if (changedAt <= seenAt) {
          skipped++;
          continue;
        }
        replacing = true;
      }
    }

    try {
      const session = parseSession(file);

      if (session.messageCount === 0) {
        skipped++;
        continue;
      }

      // Skip if session ID already exists (e.g., same session in multiple project dirs)
      if (!replacing) {
        const existingById = checkSessionId.get(session.sessionId);
        if (existingById) {
          skipped++;
          continue;
        }
      }

      const projectId = session.projectName;

      db.transaction(() => {
        if (replacing) {
          deleteConvo.run(session.sessionId);
          deleteSession.run(session.sessionId);
        }
        insertProject.run(
          projectId,
          session.projectPath,
          session.projectName
        );
        const isSubagent = file.includes("/subagents/") ? 1 : 0;
        insertSession.run(
          session.sessionId,
          session.parentSessionId,
          projectId,
          session.projectPath,
          file,
          session.startedAt,
          session.endedAt,
          session.gitBranch,
          session.version,
          session.messageCount,
          isSubagent
        );
        insertConvo.run(session.sessionId, session.toMarkdown());
      })();

      ingested++;
    } catch (err) {
      errors.push(`${file}: ${err}`);
    }
  }

  // Update project aggregate fields
  db.exec(`
    UPDATE projects SET
      first_session_at = (SELECT MIN(started_at) FROM sessions WHERE sessions.project_id = projects.id),
      last_session_at = (SELECT MAX(started_at) FROM sessions WHERE sessions.project_id = projects.id),
      session_count = (SELECT COUNT(*) FROM sessions WHERE sessions.project_id = projects.id)
  `);

  return { ingested, skipped, errors };
}
