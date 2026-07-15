-- 0041_batch_extractions_pending.sql
-- Queue of doc_ids waiting to be batched to LLM providers for extraction.

CREATE TABLE IF NOT EXISTS batch_extractions_pending (
  doc_id        TEXT PRIMARY KEY,
  chamber       TEXT NOT NULL,
  enqueued_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_batch_pending_enqueued ON batch_extractions_pending (enqueued_at);
