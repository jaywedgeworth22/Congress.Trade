-- 0020_disclosure_available_generated.sql
-- Add generated column and index for point-in-time disclosure availability.

ALTER TABLE transactions ADD COLUMN first_seen_at TEXT;
ALTER TABLE transactions ADD COLUMN filed_date TEXT;

UPDATE transactions SET
  first_seen_at = (SELECT first_seen_at FROM filings WHERE filings.doc_id = transactions.doc_id),
  filed_date = (SELECT filed_date FROM filings WHERE filings.doc_id = transactions.doc_id);

ALTER TABLE transactions ADD COLUMN disclosure_available_at TEXT GENERATED ALWAYS AS (
  COALESCE(first_seen_at, CASE WHEN filed_date IS NOT NULL THEN filed_date || 'T00:00:00.000Z' END, created_at)
);

CREATE INDEX IF NOT EXISTS idx_tx_disclosure_available_ticker ON transactions (disclosure_available_at, ticker, id);
