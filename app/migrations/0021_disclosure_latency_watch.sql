-- 0021_disclosure_latency_watch.sql
-- Records Congress.Trade-vs-FMP disclosure discovery timing. Candidates are
-- created when our watcher first sees a new filing; provider observations are
-- populated from FMP latest endpoints so we can tell whether FMP was already
-- aware or caught up later.

CREATE TABLE IF NOT EXISTS disclosure_latency_candidates (
  doc_id                 TEXT NOT NULL,
  provider               TEXT NOT NULL DEFAULT 'fmp',
  chamber                TEXT NOT NULL,
  source_url             TEXT,
  filed_date             TEXT,
  filer_name             TEXT,
  congress_first_seen_at TEXT NOT NULL,
  provider_key           TEXT,
  provider_first_seen_at TEXT,
  match_method           TEXT,
  status                 TEXT NOT NULL DEFAULT 'pending',
  attempts               INTEGER NOT NULL DEFAULT 0,
  last_checked_at        TEXT,
  error                  TEXT,
  payload                TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  PRIMARY KEY (doc_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_disc_latency_candidates_status
  ON disclosure_latency_candidates (provider, status, created_at DESC);

CREATE TABLE IF NOT EXISTS disclosure_provider_observations (
  provider          TEXT NOT NULL,
  chamber           TEXT NOT NULL,
  provider_key      TEXT NOT NULL,
  first_observed_at TEXT NOT NULL,
  last_observed_at  TEXT NOT NULL,
  source_url        TEXT,
  filed_date        TEXT,
  filer_name        TEXT,
  payload           TEXT,
  PRIMARY KEY (provider, chamber, provider_key)
);

CREATE INDEX IF NOT EXISTS idx_disc_provider_seen
  ON disclosure_provider_observations (provider, chamber, first_observed_at DESC);
