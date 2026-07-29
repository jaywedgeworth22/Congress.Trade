-- 0064_deno_runtime_queue_dead_letter_cycles.sql
-- Track dead-letter recovery cycles so a poison DLQ receipt terminally fails
-- after DURABLE_QUEUE_MAX_DEAD_LETTER_CYCLES instead of looping forever.
-- Idempotent on prod: POST /api/admin/migrate treats "duplicate column" as applied.

ALTER TABLE deno_runtime_queue ADD COLUMN dead_letter_cycles INTEGER NOT NULL DEFAULT 0;
