-- 0013_tx_deprecation.sql
-- Soft-delete support for transactions so an admin can UN-PUBLISH a filing's
-- rows after they were confirmed (e.g. a bad review decision) without hard
-- deleting history. deprecated_at IS NULL means "live"; a timestamp means the
-- row is retracted and must be excluded from every feed/analytics/stream read.

ALTER TABLE transactions ADD COLUMN deprecated_at TEXT;       -- ISO ts when retracted, else NULL
ALTER TABLE transactions ADD COLUMN deprecated_reason TEXT;   -- admin note, else NULL

-- Partial-ish index to keep the common "live rows only" scans cheap.
CREATE INDEX IF NOT EXISTS idx_tx_deprecated_at ON transactions (deprecated_at);
