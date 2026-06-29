-- 0019_ingestion_decisions.sql
-- Append-only audit trail for filing/trade publication decisions. This keeps
-- the review_queue focused on exceptions while preserving every publish/review
-- decision for admin history and future scoring/debugging.

CREATE TABLE IF NOT EXISTS ingestion_decisions (
  id              TEXT PRIMARY KEY,
  doc_id          TEXT NOT NULL,
  action          TEXT NOT NULL,
  source          TEXT NOT NULL,
  actor           TEXT,
  reason          TEXT,
  payload         TEXT,
  transaction_ids TEXT NOT NULL DEFAULT '[]',
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ingestion_decisions_doc
  ON ingestion_decisions (doc_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ingestion_decisions_created
  ON ingestion_decisions (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ingestion_decisions_action
  ON ingestion_decisions (action, created_at DESC);
