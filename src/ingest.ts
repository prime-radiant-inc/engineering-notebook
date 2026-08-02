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
  force = false,
  onProgress?: (done: number, total: number) => void
): {
  ingested: number; skipped: number; errors: string[];
  alreadyIngested: number; empty: number; duplicateId: number; totalMessages: number;
} {
  let ingested = 0, alreadyIngested = 0, empty = 0, duplicateId = 0, totalMessages = 0;
  const errors: string[] = [];

  const checkStmt = db.query("SELECT id FROM sessions WHERE source_path = ?");
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

  for (let i = 0; i < files.length; i++) {
    onProgress?.(i, files.length);
    const file = files[i]!;

    if (!force && checkStmt.get(file)) {
      alreadyIngested++;
      continue;
    }

    try {
      const session = parseSession(file);

      if (session.messageCount === 0) {
        empty++;
        continue;
      }

      // Skip if session ID already exists (e.g., same session in multiple project dirs)
      if (!force && checkSessionId.get(session.sessionId)) {
        duplicateId++;
        continue;
      }

      const projectId = session.projectName;

      db.transaction(() => {
        if (force) {
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
      totalMessages += session.messageCount;
    } catch (err) {
      errors.push(`${file}: ${err}`);
    }
  }
  onProgress?.(files.length, files.length);

  // Update project aggregate fields
  db.exec(`
    UPDATE projects SET
      first_session_at = (SELECT MIN(started_at) FROM sessions WHERE sessions.project_id = projects.id),
      last_session_at = (SELECT MAX(started_at) FROM sessions WHERE sessions.project_id = projects.id),
      session_count = (SELECT COUNT(*) FROM sessions WHERE sessions.project_id = projects.id)
  `);

  return {
    ingested, skipped: alreadyIngested + empty + duplicateId, errors,
    alreadyIngested, empty, duplicateId, totalMessages,
  };
}
