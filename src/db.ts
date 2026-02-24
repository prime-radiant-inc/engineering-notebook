import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";

let _db: Database | null = null;

export function initDb(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      first_session_at TEXT,
      last_session_at TEXT,
      session_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      parent_session_id TEXT,
      project_id TEXT NOT NULL REFERENCES projects(id),
      project_path TEXT NOT NULL,
      source_path TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      git_branch TEXT,
      version TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      ingested_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
      conversation_markdown TEXT NOT NULL,
      extracted_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS journal_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id),
      session_ids TEXT NOT NULL DEFAULT '[]',
      headline TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL,
      topics TEXT NOT NULL DEFAULT '[]',
      commits TEXT,
      generated_at TEXT NOT NULL,
      model_used TEXT NOT NULL,
      UNIQUE(date, project_id)
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
    CREATE INDEX IF NOT EXISTS idx_journal_date ON journal_entries(date);
    CREATE INDEX IF NOT EXISTS idx_journal_project ON journal_entries(project_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source_path);
  `);

  // Migrations
  try {
    db.exec(`ALTER TABLE journal_entries ADD COLUMN open_questions TEXT NOT NULL DEFAULT '[]'`);
  } catch {
    // Column already exists — ignore
  }
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN is_subagent INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists — ignore
  }

  _db = db;
  return db;
}

export function getDb(dbPath?: string): Database {
  if (_db) return _db;
  if (!dbPath) throw new Error("Database not initialized — call initDb first");
  return initDb(dbPath);
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
