CREATE TABLE deno_runtime_queue (
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
CREATE INDEX idx_deno_runtime_queue_ready ON deno_runtime_queue (status, available_at, id);
EXPLAIN QUERY PLAN
UPDATE deno_runtime_queue
      SET status = 'processing',
          attempts = attempts + 1,
          lease_until = 'x',
          lease_token = 'y',
          updated_at = 'z'
      WHERE id IN (
        SELECT id FROM (
          SELECT id, available_at FROM deno_runtime_queue
          WHERE queue_name = 'ingest' AND status = 'pending' AND available_at <= 'z'
          UNION ALL
          SELECT id, available_at FROM deno_runtime_queue
          WHERE queue_name = 'ingest' AND status = 'processing' AND lease_until <= 'z'
        )
        ORDER BY available_at ASC, id ASC
        LIMIT 10
      );
