-- 0023_disclosure_provider_timestamps.sql
-- Stores provider-supplied publication/upload timestamps separately from the
-- monitor's first-observed timestamp. Not every provider exposes this.

ALTER TABLE disclosure_latency_candidates ADD COLUMN provider_published_at TEXT;
ALTER TABLE disclosure_provider_observations ADD COLUMN provider_published_at TEXT;
