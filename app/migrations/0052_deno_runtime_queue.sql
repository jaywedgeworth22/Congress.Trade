-- Deno Deploy's remote KV Connect API does not implement KV queues. Persist
-- every runtime queue handoff in Turso so ingestion and delivery survive
-- isolate restarts and can be drained by the per-minute Deno cron.
CREATE TABLE IF NOT EXISTS deno_runtime_queue (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_name   TEXT NOT NULL,
  dedupe_key   TEXT,
  payload      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  attempts     INTEGER NOT NULL DEFAULT 0,
  dead_letter_pending INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  lease_until  TEXT,
  lease_token  TEXT,
  last_error   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deno_runtime_queue_ready
  ON deno_runtime_queue (status, available_at, id);

-- Collapse only concurrently-active duplicates. Completed/failed rows retain
-- their audit history and do not block an intentional later retry.
CREATE UNIQUE INDEX IF NOT EXISTS idx_deno_runtime_queue_active_dedupe
  ON deno_runtime_queue (queue_name, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'processing');
