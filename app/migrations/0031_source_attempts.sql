-- Truthful source polling history. ingest_log remains the successful-yield
-- ledger; this table records both successes and failures explicitly.
CREATE TABLE IF NOT EXISTS source_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source       TEXT NOT NULL,
  attempted_at TEXT NOT NULL,
  outcome      TEXT NOT NULL, -- success | failure
  new_count    INTEGER NOT NULL DEFAULT 0,
  error        TEXT
);

CREATE INDEX IF NOT EXISTS idx_source_attempts_source_time
  ON source_attempts (source, attempted_at DESC);
