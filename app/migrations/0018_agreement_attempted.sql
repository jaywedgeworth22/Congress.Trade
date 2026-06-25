-- 0017_agreement_attempted.sql
-- Tracks the one autonomous cross-vendor agreement attempt per review doc, so
-- the per-minute cron never re-reads a doc that already disagreed. Additive.

ALTER TABLE review_queue ADD COLUMN agreement_attempted_at TEXT;
CREATE INDEX IF NOT EXISTS idx_review_queue_agreement ON review_queue (agreement_attempted_at);
