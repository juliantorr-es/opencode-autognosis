-- Migration: 005_honor_system
-- Description: Add tables for Agent Profiles, Run Evaluations, and Honor Events

CREATE TABLE IF NOT EXISTS agent_profiles (
    id TEXT PRIMARY KEY,
    agent_id TEXT UNIQUE NOT NULL,
    rank TEXT DEFAULT 'bronze',
    mmr INTEGER DEFAULT 1000,
    streak INTEGER DEFAULT 0,
    probation BOOLEAN DEFAULT 0,
    stats TEXT, -- JSON object
    allowed_tools TEXT, -- JSON array
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS run_evals (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    score REAL NOT NULL,
    breakdown TEXT, -- JSON object
    reasons TEXT,   -- JSON array
    evidence_ids TEXT, -- JSON array
    mmr_delta INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS honor_events (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    type TEXT NOT NULL,
    from_rank TEXT,
    to_rank TEXT NOT NULL,
    reason TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_profiles_rank ON agent_profiles(rank);
CREATE INDEX IF NOT EXISTS idx_run_evals_agent ON run_evals(agent_id);
