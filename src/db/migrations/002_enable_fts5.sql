-- Migration: 002_enable_fts5
-- Description: Enable Full-Text Search for chunks and symbols

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    id UNINDEXED,
    content_summary,
    type,
    content='chunks',
    content_rowid='rowid'
);

-- Triggers to keep FTS index in sync
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, id, content_summary, type) VALUES (new.rowid, new.id, new.content_summary, new.type);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, id, content_summary, type) VALUES('delete', old.rowid, old.id, old.content_summary, old.type);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, id, content_summary, type) VALUES('delete', old.rowid, old.id, old.content_summary, old.type);
  INSERT INTO chunks_fts(rowid, id, content_summary, type) VALUES (new.rowid, new.id, new.content_summary, new.type);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
    name,
    content='symbols',
    content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS symbols_ai AFTER INSERT ON symbols BEGIN
  INSERT INTO symbols_fts(rowid, name) VALUES (new.rowid, new.name);
END;

CREATE TRIGGER IF NOT EXISTS symbols_ad AFTER DELETE ON symbols BEGIN
  INSERT INTO symbols_fts(symbols_fts, rowid, name) VALUES('delete', old.rowid, old.name);
END;

CREATE TRIGGER IF NOT EXISTS symbols_au AFTER UPDATE ON symbols BEGIN
  INSERT INTO symbols_fts(symbols_fts, rowid, name) VALUES('delete', old.rowid, old.name);
  INSERT INTO symbols_fts(rowid, name) VALUES (new.rowid, new.name);
END;
