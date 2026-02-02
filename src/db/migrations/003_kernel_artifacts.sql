-- Migration: 003_kernel_artifacts
-- Description: Add tables for ChangeSessions, JobArtifacts, SkillArtifacts, and TraceArtifacts

CREATE TABLE IF NOT EXISTS change_sessions (
    id TEXT PRIMARY KEY,
    token TEXT UNIQUE NOT NULL,
    base_commit TEXT NOT NULL,
    worktree_name TEXT,
    intent TEXT NOT NULL,
    status TEXT NOT NULL,
    files_touched TEXT, -- JSON array
    patch_ids TEXT,     -- JSON array
    verification_results TEXT, -- JSON array
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS job_artifacts (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    logs TEXT, -- JSON array
    outputs TEXT, -- JSON object
    final_summary TEXT,
    agent_id TEXT,
    git_hash TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS skill_artifacts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    scope TEXT NOT NULL,
    instructions TEXT NOT NULL,
    agent_id TEXT,
    git_hash TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS trace_artifacts (
    id TEXT PRIMARY KEY,
    hook_event TEXT,
    tool_invocation TEXT,
    inputs TEXT, -- JSON
    outputs TEXT, -- JSON
    duration_ms INTEGER,
    artifacts_produced TEXT, -- JSON array
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pruning_map (
    artifact_id TEXT PRIMARY KEY,
    start_turn INTEGER,
    end_turn INTEGER,
    is_eligible BOOLEAN DEFAULT 1
);

CREATE TABLE IF NOT EXISTS worker_registry (
    pid INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL,
    command TEXT,
    cwd TEXT,
    start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_heartbeat DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'alive'
);

CREATE INDEX IF NOT EXISTS idx_change_sessions_token ON change_sessions(token);
CREATE INDEX IF NOT EXISTS idx_skills_scope ON skill_artifacts(scope);
