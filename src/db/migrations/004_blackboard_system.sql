-- Migration: 004_blackboard_system
-- Description: Upgrade blackboard to structured evidence-first system

DROP TABLE IF EXISTS blackboard; -- Purge legacy log

CREATE TABLE IF NOT EXISTS board_posts (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    type TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT DEFAULT 'open',
    agent_id TEXT NOT NULL,
    git_hash TEXT,
    evidence_ids TEXT, -- JSON array
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS board_replies (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL,
    type TEXT NOT NULL,
    body TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    git_hash TEXT,
    evidence_ids TEXT, -- JSON array
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(post_id) REFERENCES board_posts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_board_posts_type ON board_posts(type);
CREATE INDEX IF NOT EXISTS idx_board_posts_status ON board_posts(status);
CREATE INDEX IF NOT EXISTS idx_board_replies_post ON board_replies(post_id);
