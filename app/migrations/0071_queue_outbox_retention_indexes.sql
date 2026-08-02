-- 0071_queue_outbox_retention_indexes.sql
-- Age indexes for the durable-queue retention policies added to
-- src/jobs.ts RETENTION_POLICIES. The sweep deletes with
--   WHERE <key> IN (SELECT <key> FROM t WHERE updated_at < ? AND status = 'x' LIMIT n)
-- so it needs an index it can range-scan by age within one status.

CREATE INDEX IF NOT EXISTS idx_deno_runtime_queue_completed_updated
  ON deno_runtime_queue (updated_at) WHERE status = 'completed';

CREATE INDEX IF NOT EXISTS idx_deno_runtime_queue_failed_updated
  ON deno_runtime_queue (updated_at) WHERE status = 'failed';
