-- 0058_turso_query_efficiency.sql
-- Turso metrics showed claim ORDER BY (available_at, id) and migrate backfills
-- for disclosure / latest_price_date anchors still probing wide indexes after
-- the one-time seed completed. Cover the claim sort keys and add partial
-- indexes so post-seed /migrate replays are near no-ops. Also seed a singleton
-- price_eod_stats row so admin status receipts never COUNT(*) the full cache.

CREATE INDEX IF NOT EXISTS idx_deno_runtime_queue_pending_id
  ON deno_runtime_queue (queue_name, status, available_at, id);
CREATE INDEX IF NOT EXISTS idx_deno_runtime_queue_processing_id
  ON deno_runtime_queue (queue_name, status, lease_until, id);
DROP INDEX IF EXISTS idx_deno_runtime_queue_pending;
DROP INDEX IF EXISTS idx_deno_runtime_queue_processing;

CREATE INDEX IF NOT EXISTS idx_tx_missing_disclosure_anchors
  ON transactions (doc_id)
  WHERE first_seen_at IS NULL OR filed_date IS NULL;

CREATE INDEX IF NOT EXISTS idx_secref_missing_latest_price_date
  ON securities_ref (ticker)
  WHERE latest_price_date IS NULL;

CREATE TABLE IF NOT EXISTS price_eod_stats (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  row_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO price_eod_stats (id, row_count, updated_at)
  VALUES (1, 0, '1970-01-01T00:00:00.000Z');

-- One-shot seed: COUNT(*) only while row_count is still 0.
UPDATE price_eod_stats
   SET row_count = (SELECT COUNT(*) FROM price_eod),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE id = 1 AND row_count = 0;
