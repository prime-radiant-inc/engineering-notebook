import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

let _db: Database | null = null;

export function initDb(dbPath: string): Database {
  const resolvedPath = dbPath.startsWith("~/")
    ? join(homedir(), dbPath.slice(2))
    : dbPath;
  mkdirSync(dirname(resolvedPath), { recursive: true });

  const db = new Database(resolvedPath, { create: true });
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

    CREATE TABLE IF NOT EXISTS journal_invocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_id INTEGER REFERENCES journal_invocations(id) ON DELETE CASCADE,
      journal_entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
      scope_start INTEGER NOT NULL,
      scope_end INTEGER NOT NULL,
      depth INTEGER NOT NULL,
      coherence_token TEXT NOT NULL,
      question TEXT NOT NULL,
      actions TEXT NOT NULL DEFAULT '[]',
      started_at TEXT NOT NULL,
      ended_at TEXT
    );

    CREATE TABLE IF NOT EXISTS journal_fragments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      journal_entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
      invocation_id INTEGER REFERENCES journal_invocations(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      char_start INTEGER NOT NULL,
      char_end INTEGER NOT NULL,
      span_checksum TEXT NOT NULL,
      category TEXT NOT NULL,
      text TEXT NOT NULL,
      extracted_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS journal_rollups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period TEXT NOT NULL,
      period_start TEXT NOT NULL,
      project_id TEXT NOT NULL DEFAULT '',
      headline TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      topics TEXT NOT NULL DEFAULT '[]',
      open_questions TEXT NOT NULL DEFAULT '[]',
      sources_count INTEGER NOT NULL DEFAULT 0,
      reaudited_dates TEXT NOT NULL DEFAULT '[]',
      generated_at TEXT NOT NULL,
      model_used TEXT NOT NULL,
      UNIQUE(period, period_start, project_id)
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
    CREATE INDEX IF NOT EXISTS idx_journal_date ON journal_entries(date);
    CREATE INDEX IF NOT EXISTS idx_journal_project ON journal_entries(project_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source_path);
    CREATE INDEX IF NOT EXISTS idx_rollups_period ON journal_rollups(period, period_start);
    CREATE INDEX IF NOT EXISTS idx_rollups_project ON journal_rollups(project_id);
    CREATE INDEX IF NOT EXISTS idx_fragments_entry ON journal_fragments(journal_entry_id);
    CREATE INDEX IF NOT EXISTS idx_fragments_session ON journal_fragments(session_id);
    CREATE INDEX IF NOT EXISTS idx_fragments_invocation ON journal_fragments(invocation_id);
    CREATE INDEX IF NOT EXISTS idx_invocations_entry ON journal_invocations(journal_entry_id);
    CREATE INDEX IF NOT EXISTS idx_invocations_parent ON journal_invocations(parent_id);
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
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN source_size INTEGER`);
  } catch {
    // Column already exists — ignore
  }
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN source_mtime TEXT`);
  } catch {
    // Column already exists — ignore
  }
  // Migrate journal_fragments to add invocation_id with proper FK + cascade.
  //
  // SQLite forbids `ALTER TABLE ADD COLUMN ... REFERENCES`, so the
  // canonical fix is the table-rebuild dance: create the new shape, copy
  // data, drop the old, rename. Detect whether migration is needed by
  // checking whether the existing column has the FK; if not, rebuild.
  const fragmentSchema = db
    .query<{ sql: string }, []>(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'journal_fragments'`
    )
    .get();
  const fragmentColumns = db
    .query<{ name: string }, []>(`PRAGMA table_info(journal_fragments)`)
    .all()
    .map((r) => r.name);
  const hasInvocationId = fragmentColumns.includes("invocation_id");
  const fkDeclared =
    fragmentSchema?.sql?.includes("invocation_id INTEGER REFERENCES") ?? false;
  if (!hasInvocationId || !fkDeclared) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE journal_fragments_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          journal_entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
          invocation_id INTEGER REFERENCES journal_invocations(id) ON DELETE CASCADE,
          chunk_index INTEGER NOT NULL,
          session_id TEXT NOT NULL REFERENCES sessions(id),
          char_start INTEGER NOT NULL,
          char_end INTEGER NOT NULL,
          span_checksum TEXT NOT NULL,
          category TEXT NOT NULL,
          text TEXT NOT NULL,
          extracted_at TEXT NOT NULL
        );
      `);
      // Copy data, defaulting invocation_id to NULL for any pre-existing rows
      // (those came from the long-since-deleted chunked-summarize path and
      // had no recorded invocation).
      const cols = hasInvocationId
        ? "id, journal_entry_id, invocation_id, chunk_index, session_id, char_start, char_end, span_checksum, category, text, extracted_at"
        : "id, journal_entry_id, NULL, chunk_index, session_id, char_start, char_end, span_checksum, category, text, extracted_at";
      db.exec(`
        INSERT INTO journal_fragments_new
          (id, journal_entry_id, invocation_id, chunk_index, session_id,
           char_start, char_end, span_checksum, category, text, extracted_at)
        SELECT ${cols} FROM journal_fragments;

        DROP TABLE journal_fragments;
        ALTER TABLE journal_fragments_new RENAME TO journal_fragments;

        CREATE INDEX idx_fragments_entry ON journal_fragments(journal_entry_id);
        CREATE INDEX idx_fragments_session ON journal_fragments(session_id);
        CREATE INDEX idx_fragments_invocation ON journal_fragments(invocation_id);
      `);
    })();
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
