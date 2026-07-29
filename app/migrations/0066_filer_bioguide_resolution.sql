-- 0066_filer_bioguide_resolution.sql
-- Resolved Bioguide identity for filers. The filers PRIMARY KEY (bioguide_id)
-- predates real identity resolution and stores source-specific synthetic slugs
-- (e.g. 'seed-house-<name>', 'house-<district>-<name>', 'senate-<name>',
-- 'EXEC-DJT'), so it cannot be used to join against official Bioguide-keyed
-- datasets (congress-legislators, VoteView, GovTrack, campaign-finance data).
-- Migrating the PK corpus-wide would require rewriting every filings.filer_id
-- and transactions.filer_id reference in production — deliberately NOT done.
-- Instead we add a resolved column, filled by the existing member enrichment
-- job (runPhotoEnrichment, POST /api/admin/enrich-photos + daily cron), which
-- already matches filer names against congress-legislators. COALESCE-preserve
-- semantics: an existing value is never overwritten, safe to re-run.

ALTER TABLE filers ADD COLUMN resolved_bioguide_id TEXT;

CREATE INDEX IF NOT EXISTS idx_filers_resolved_bioguide ON filers (resolved_bioguide_id);
