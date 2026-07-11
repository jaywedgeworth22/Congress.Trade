-- 0025_extraction_runs_usage.sql
-- Adds token-usage/cost capture to extraction_runs. Populated by the bake-off
-- endpoint (currently openai only — other providers leave it NULL) so
-- per-model token spend can be compared alongside row recall and latency.
-- Mirrored idempotently in POST /api/admin/migrate (src/admin/routes.ts).

ALTER TABLE extraction_runs ADD COLUMN usage_json TEXT;
