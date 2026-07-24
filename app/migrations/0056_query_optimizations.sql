CREATE INDEX IF NOT EXISTS idx_deno_runtime_queue_pending ON deno_runtime_queue (queue_name, status, available_at);
CREATE INDEX IF NOT EXISTS idx_deno_runtime_queue_processing ON deno_runtime_queue (queue_name, status, lease_until);

CREATE INDEX IF NOT EXISTS idx_ingestion_outbox_enqueued ON ingestion_outbox (status, updated_at);
CREATE INDEX IF NOT EXISTS idx_delivery_outbox_enqueued ON delivery_outbox (status, updated_at);
