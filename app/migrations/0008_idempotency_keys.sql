-- 0008_idempotency_keys.sql
-- Durable idempotency guards for live normalization and webhook delivery.

ALTER TABLE transactions ADD COLUMN row_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_doc_source_rowkey
  ON transactions (doc_id, source, row_key)
  WHERE row_key IS NOT NULL;

-- Older runs could create more than one delivery attempt row for the same
-- subscription/transaction pair. Keep the newest physical row, then enforce the
-- key the webhook code has always treated as authoritative.
DELETE FROM deliveries
 WHERE rowid NOT IN (
   SELECT MAX(rowid)
     FROM deliveries
    GROUP BY subscription_id, tx_id
 );

CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_subscription_tx
  ON deliveries (subscription_id, tx_id);
