-- 0050_doc_class.sql
-- Pre-extraction document classification (src/extraction/docClassifier.ts):
-- doc_class ∈ typed | clean_scan | hard_scan | empty | corrupt, persisted
-- next to the 0033 complexity signals (page_count/raw_bytes). Consumers:
-- autopilot run ordering (typed/clean first), cascade start tier
-- (hard_scan → tier 2 full trio), empty auto-resolve + corrupt quarantine,
-- and run-receipt attribution.
-- Mirrored idempotently in POST /api/admin/migrate (src/admin/migrations.ts).

ALTER TABLE filings ADD COLUMN doc_class TEXT;
