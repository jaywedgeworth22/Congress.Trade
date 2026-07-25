-- 0062_fix_deno_runtime_queue_index.sql
-- Fix massive read amplification in the queue worker by dropping the legacy ready index.
-- The legacy index idx_deno_runtime_queue_ready (status, available_at, id) lacked the queue_name.
-- Although 0058 added idx_deno_runtime_queue_pending_id with the correct columns, SQLite's planner
-- was still choosing the legacy index for the UNION ALL queries, causing full queue space scans.

DROP INDEX IF EXISTS idx_deno_runtime_queue_ready;
