-- Migration: 001_initial_schema
-- Description: Initial database schema for Autognosis

PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,
  hash TEXT,
  last_indexed DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  file_id INTEGER,
  type TEXT,
  complexity_score REAL,
  content_summary TEXT,
  embedding BLOB,
  parent_id TEXT, -- Hierarchical reference
  FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS embedding_queue (
  chunk_id TEXT PRIMARY KEY,
  text_to_embed TEXT,
  status TEXT DEFAULT 'pending',
  retries INTEGER DEFAULT 0,
  FOREIGN KEY(chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_id TEXT,
  name TEXT NOT NULL,
  kind TEXT,
  FOREIGN KEY(chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dependencies (
  source_chunk_id TEXT,
  target_path TEXT,
  FOREIGN KEY(source_chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caller_chunk_id TEXT,
  callee_name TEXT,
  line_number INTEGER,
  FOREIGN KEY(caller_chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS plan_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id TEXT,
  tool_name TEXT,
  args TEXT,
  is_on_plan BOOLEAN,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tool_contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_tool TEXT,
  trigger_action TEXT,
  target_tool TEXT,
  target_args TEXT,
  condition_script TEXT
);

CREATE TABLE IF NOT EXISTS blackboard (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author TEXT,
  message TEXT,
  topic TEXT,
  symbol_id TEXT,
  git_hash TEXT,
  is_archived BOOLEAN DEFAULT 0,
  is_pinned BOOLEAN DEFAULT 0,
  embedding BLOB,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS locks (
  resource_id TEXT PRIMARY KEY,
  owner_agent TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME
);

CREATE TABLE IF NOT EXISTS intents (
  patch_id TEXT PRIMARY KEY,
  reasoning TEXT,
  plan_id TEXT
);

CREATE TABLE IF NOT EXISTS arch_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_pattern TEXT,
  target_pattern TEXT,
  restriction TEXT DEFAULT 'forbidden'
);

CREATE TABLE IF NOT EXISTS commits (
  hash TEXT PRIMARY KEY,
  author TEXT,
  date DATETIME,
  message TEXT,
  files_touched TEXT
);

CREATE TABLE IF NOT EXISTS background_jobs (
  id TEXT PRIMARY KEY,
  type TEXT,
  status TEXT DEFAULT 'pending',
  progress INTEGER DEFAULT 0,
  result TEXT,
  error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS context_access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_id TEXT,
  plan_id TEXT,
  accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS performance_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation TEXT NOT NULL,
  duration_ms INTEGER,
  memory_usage_mb REAL,
  success BOOLEAN,
  error TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indices
CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_ledger_plan ON plan_ledger(plan_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON background_jobs(status);
CREATE INDEX IF NOT EXISTS idx_chunks_parent ON chunks(parent_id);
