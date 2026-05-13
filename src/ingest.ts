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

type FileStatus = {
  existingSessionId: string | null;
  storedSize: number | null;
  storedMtime: string | null;
  recordedDate: string | null;
  recordedProjectId: string | null;
};

/** Ingest session files into the database.
 *  Tracks each file's mtime+size so files that have grown (Claude/Codex append
 *  to their session JSONL during use) are detected and re-ingested. When a
 *  session is re-ingested, journal entries covering its (date, project) are
 *  deleted so the next summarize run regenerates them from updated content. */
export function ingestSessions(
  files: string[],
  db: Database,
  force = false
): {
  ingested: number;
  reingested: number;
  skipped: number;
  invalidatedJournals: number;
  errors: string[];
} {
  let ingested = 0;
  let reingested = 0;
  let skipped = 0;
  let invalidatedJournals = 0;
  const errors: string[] = [];

  const checkStmt = db.query<FileStatus, [string]>(`
    SELECT
      id as existingSessionId,
      source_size as storedSize,
      source_mtime as storedMtime,
      date(started_at) as recordedDate,
      project_id as recordedProjectId
    FROM sessions WHERE source_path = ?
  `);
  const checkSessionId = db.query("SELECT id FROM sessions WHERE id = ?");
  const insertProject = db.prepare(`
    INSERT INTO projects (id, path, display_name, session_count)
    VALUES (?, ?, ?, 0)
    ON CONFLICT(id) DO UPDATE SET path = excluded.path
  `);
  const insertSession = db.prepare(`
    INSERT INTO sessions (id, parent_session_id, project_id, project_path, source_path, started_at, ended_at, git_branch, version, message_count, is_subagent, source_size, source_mtime, ingested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const insertConvo = db.prepare(`
    INSERT INTO conversations (session_id, conversation_markdown, extracted_at)
    VALUES (?, ?, datetime('now'))
  `);
  const deleteConvo = db.prepare(`DELETE FROM conversations WHERE session_id = ?`);
  const deleteSession = db.prepare(`DELETE FROM sessions WHERE id = ?`);
  const deleteJournal = db.prepare(
    `DELETE FROM journal_entries WHERE date = ? AND project_id = ?`
  );

  for (const file of files) {
    let stat;
    try {
      stat = statSync(file);
    } catch (err) {
      errors.push(`${file}: stat failed: ${err}`);
      continue;
    }
    const currentSize = stat.size;
    const currentMtime = stat.mtime.toISOString();

    const existing = checkStmt.get(file);
    const isReingest = existing !== null && !force;

    if (existing && !force) {
      // Skip unchanged files (both mtime and size match what we stored).
      if (
        existing.storedSize === currentSize &&
        existing.storedMtime === currentMtime
      ) {
        skipped++;
        continue;
      }
      // Otherwise fall through and re-ingest.
    }

    try {
      const session = parseSession(file);

      if (session.messageCount === 0) {
        skipped++;
        continue;
      }

      // Skip if a different file already owns this session ID.
      if (!force && !existing) {
        const existingById = checkSessionId.get(session.sessionId);
        if (existingById) {
          skipped++;
          continue;
        }
      }

      const projectId = session.projectName;
      const newDate = session.startedAt.slice(0, 10);

      db.transaction(() => {
        // For both --force and detected-change re-ingest: drop old rows first.
        if (force || existing) {
          deleteConvo.run(session.sessionId);
          deleteSession.run(session.sessionId);
        }

        // Invalidate any journal entries this session contributed to.
        // For a session whose date or project_id changed since last ingest,
        // both the old and new (date, project_id) tuples must be invalidated.
        const tuplesToInvalidate = new Set<string>();
        if (existing?.recordedDate && existing?.recordedProjectId) {
          tuplesToInvalidate.add(
            `${existing.recordedDate}|${existing.recordedProjectId}`
          );
        }
        if (isReingest || force) {
          tuplesToInvalidate.add(`${newDate}|${projectId}`);
        }
        for (const tuple of tuplesToInvalidate) {
          const [date, pid] = tuple.split("|", 2) as [string, string];
          const result = deleteJournal.run(date, pid);
          invalidatedJournals += result.changes;
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
          isSubagent,
          currentSize,
          currentMtime
        );
        insertConvo.run(session.sessionId, session.toMarkdown());
      })();

      if (isReingest || (force && existing)) {
        reingested++;
      } else {
        ingested++;
      }
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

  return { ingested, reingested, skipped, invalidatedJournals, errors };
}
