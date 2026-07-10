-- 0026_agreement_cascade.sql
-- Tiered agreement cascade bookkeeping on review_queue. Replaces the once-ever
-- `agreement_attempted_at` semantics with a capped attempt counter plus the tier
-- the doc has escalated to (1 = A/B cross-vendor, 2 = +model C, 3 = majority
-- resolve). agreement_attempted_at is KEPT and still stamped for backward
-- compatibility (older cron/admin queries filter on it). Both columns are
-- additive and default via COALESCE in code (no server-side DEFAULT so existing
-- rows read as NULL -> treated as 0 attempts / tier 1).
-- Mirrored idempotently in POST /api/admin/migrate (src/admin/routes.ts).

ALTER TABLE review_queue ADD COLUMN agreement_attempts INTEGER;
ALTER TABLE review_queue ADD COLUMN agreement_tier INTEGER;
