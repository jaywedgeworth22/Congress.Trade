-- 0063_filings_filed_date_index.sql
-- Index filings.filed_date for the 5-year filing retention sweep
-- (runFilingRetentionSweep in src/jobs.ts), which selects expired batches via
-- `WHERE filed_date < ? LIMIT ?`. Without a leading filed_date index that
-- daily sweep full-scans the filings table once per batch.

CREATE INDEX IF NOT EXISTS idx_filings_filed_date ON filings (filed_date);
