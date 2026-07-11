-- 0033_doc_complexity_signals.sql
-- Document complexity signals for cascade tiering: raw byte length and (when
-- cheaply available) page count of the source filing document. Both are
-- nullable and populated best-effort by the extraction orchestrator; a NULL
-- simply means the signal wasn't recorded (older rows, or an extractor path
-- that doesn't expose page count cheaply).
-- Mirrored idempotently in POST /api/admin/migrate (src/admin/migrations.ts).

ALTER TABLE filings ADD COLUMN page_count INTEGER;
ALTER TABLE filings ADD COLUMN raw_bytes INTEGER;
