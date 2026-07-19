-- 0048_retention_indexes.sql
-- Timestamp-leading indexes for the daily retention sweep (src/jobs.ts). Each
-- policy deletes in bounded batches via `WHERE <ts> < ?`, filtering on the age
-- column alone. dead_letter_events already has idx_dead_letter_created, but
-- ingest_log and source_attempts only carried (source, <ts>) composites whose
-- leading `source` column the age-only predicate cannot use — so those deletes
-- full-scanned. These single-column indexes let the LIMIT subquery range-scan
-- by age instead, keeping the sweep's D1 row-read cost bounded as the telemetry
-- tables grow.

CREATE INDEX IF NOT EXISTS idx_ingest_log_polled_at ON ingest_log (polled_at);
CREATE INDEX IF NOT EXISTS idx_source_attempts_attempted_at ON source_attempts (attempted_at);
