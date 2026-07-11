-- 0033_review_resolution_safety.sql
-- Durable human holds prevent an explicit Reject/Unpublish decision from being
-- immediately undone by the autonomous agreement cascade. The live-row-only
-- idempotency index allows a corrected filing to be published again after its
-- previous rows were soft-deprecated, while still preventing duplicate live
-- rows. Mirrored idempotently in POST /api/admin/migrate.

ALTER TABLE review_queue ADD COLUMN agreement_suppressed_at TEXT;
ALTER TABLE review_queue ADD COLUMN agreement_suppression_reason TEXT;

-- Preserve holds created by the deploy-before-migrate compatibility path and
-- by older builds that encoded the human action only in review_queue.reason.
UPDATE review_queue
   SET agreement_suppressed_at = COALESCE(agreement_suppressed_at, CURRENT_TIMESTAMP),
       agreement_suppression_reason = COALESCE(agreement_suppression_reason, reason)
 WHERE reason LIKE 'unpublished:%' OR reason LIKE 'rejected:%';

-- Create the replacement first. The older, stricter index guarantees this is
-- clean, and repeated admin migrations never open a no-uniqueness window.
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_live_doc_source_rowkey
  ON transactions (doc_id, source, row_key)
  WHERE row_key IS NOT NULL AND deprecated_at IS NULL;
DROP INDEX IF EXISTS idx_transactions_doc_source_rowkey;

CREATE INDEX IF NOT EXISTS idx_review_queue_agreement_suppressed
  ON review_queue (resolved, agreement_suppressed_at, created_at);

-- Review resolutions commit an outbox row in the same D1 batch as their
-- transactions. Queue producer failures are then retried by the minute cron;
-- downstream delivery remains idempotent on subscription_id + tx_id.
CREATE TABLE IF NOT EXISTS review_delivery_outbox (
  tx_id           TEXT PRIMARY KEY,
  doc_id          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  dispatched_at   TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  last_error      TEXT
);
CREATE INDEX IF NOT EXISTS idx_review_delivery_outbox_pending
  ON review_delivery_outbox (dispatched_at, created_at);
