-- 0037_review_revision.sql
-- Optimistic concurrency version for queued review content. Admin decisions
-- must name the version they reviewed so a later normalizer/cascade update
-- cannot be overwritten by a stale editor tab.

ALTER TABLE review_queue ADD COLUMN review_revision INTEGER NOT NULL DEFAULT 1;
