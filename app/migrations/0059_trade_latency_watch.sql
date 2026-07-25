-- 0022_trade_latency_watch.sql
-- Transitions latency tracking from document-based (disclosure_latency_candidates)
-- to trade-based (trade_latency_candidates) to handle discrepancies across providers
-- tracking the individual trades instead of just the containing report documents.

CREATE TABLE IF NOT EXISTS trade_latency_candidates (
  trade_hash             TEXT NOT NULL,
  doc_id                 TEXT NOT NULL,
  provider               TEXT NOT NULL DEFAULT 'fmp',
  chamber                TEXT NOT NULL,
  filed_date             TEXT,
  filer_name             TEXT,
  ticker                 TEXT,
  tx_date                TEXT,
  tx_type                TEXT,
  congress_first_seen_at TEXT NOT NULL,
  provider_key           TEXT,
  provider_first_seen_at TEXT,
  provider_published_at TEXT,
  match_method           TEXT,
  status                 TEXT NOT NULL DEFAULT 'pending',
  attempts               INTEGER NOT NULL DEFAULT 0,
  last_checked_at        TEXT,
  error                  TEXT,
  payload                TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  PRIMARY KEY (trade_hash, provider)
);

CREATE INDEX IF NOT EXISTS idx_trade_latency_candidates_status
  ON trade_latency_candidates (provider, status, created_at DESC);

CREATE TABLE IF NOT EXISTS trade_provider_observations (
  provider          TEXT NOT NULL,
  chamber           TEXT NOT NULL,
  provider_key      TEXT NOT NULL,
  trade_hash        TEXT NOT NULL,
  first_observed_at TEXT NOT NULL,
  last_observed_at  TEXT NOT NULL,
  provider_published_at TEXT,
  source_url        TEXT,
  filed_date        TEXT,
  filer_name        TEXT,
  payload           TEXT,
  PRIMARY KEY (provider, chamber, provider_key, trade_hash)
);

CREATE INDEX IF NOT EXISTS idx_trade_provider_seen
  ON trade_provider_observations (provider, chamber, first_observed_at DESC);

-- Drop the old tables to clean up schema since we're pivoting entirely
DROP TABLE IF EXISTS disclosure_latency_candidates;
DROP TABLE IF EXISTS disclosure_provider_observations;
