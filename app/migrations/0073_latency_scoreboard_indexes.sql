-- 0073_latency_scoreboard_indexes.sql
-- Speed scoreboard + exact trade-hash match path indexes.
-- The latency probe joins pending candidates to provider observations by
-- trade_hash; the public /latency-summary filters by congress_first_seen_at
-- and last_observed_at. Without these indexes both paths full-scan.

CREATE INDEX IF NOT EXISTS idx_trade_latency_candidates_seen
  ON trade_latency_candidates (provider, status, congress_first_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_trade_latency_candidates_updated
  ON trade_latency_candidates (updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_trade_provider_hash
  ON trade_provider_observations (provider, trade_hash, chamber);

CREATE INDEX IF NOT EXISTS idx_trade_provider_last_obs
  ON trade_provider_observations (last_observed_at DESC);
