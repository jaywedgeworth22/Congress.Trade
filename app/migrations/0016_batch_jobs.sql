-- 0016_batch_jobs.sql
-- Tracks async LLM batch jobs submitted for backlog reprocessing (~50% cheaper
-- than sync). One row per submitted batch; polled later to record turnaround and
-- fan results into extraction_runs (kind='batch'). Additive.

CREATE TABLE IF NOT EXISTS batch_jobs (
  id                TEXT PRIMARY KEY,      -- our uuid
  provider          TEXT NOT NULL,         -- anthropic | openai | mistral
  model             TEXT NOT NULL,
  provider_batch_id TEXT,                  -- the provider's batch/job id
  doc_ids           TEXT NOT NULL,         -- JSON array of doc_ids in the batch
  status            TEXT NOT NULL,         -- submitted | running | completed | failed
  submitted_at      TEXT NOT NULL,
  completed_at      TEXT,
  turnaround_ms     INTEGER,
  result_summary    TEXT,                  -- JSON {docs, ok, rows, errors}
  error             TEXT
);

CREATE INDEX IF NOT EXISTS idx_batch_jobs_status    ON batch_jobs (status);
CREATE INDEX IF NOT EXISTS idx_batch_jobs_submitted ON batch_jobs (submitted_at);
