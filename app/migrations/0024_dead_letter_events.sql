-- 0024_dead_letter_events.sql
-- Operator log for queue messages that exhaust their retry budget and are
-- dead-lettered. wrangler.toml routes terminal ingest/delivery failures to a
-- DLQ, but nothing recorded them; this table + a throttled admin alert (see
-- src/delivery/deadLetter.ts) make terminal failures visible instead of silent.
-- Mirrored idempotently in POST /api/admin/migrate (src/admin/routes.ts).
CREATE TABLE IF NOT EXISTS dead_letter_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue TEXT NOT NULL,
  msg_type TEXT,
  doc_id TEXT,
  tx_id TEXT,
  attempts INTEGER,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dead_letter_created ON dead_letter_events(created_at);
