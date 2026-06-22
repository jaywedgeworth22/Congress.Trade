-- 0005_securities_ref.sql
-- Phase B: cross-referenced asset reference data (sector, market cap, country,
-- exchange, …) keyed by ticker. Populated by the enrichment service from FMP
-- (key-gated) and SEC EDGAR (free). LEFT JOIN'd on read so it's safe to ship
-- before/without any data; all columns are nullable.

CREATE TABLE IF NOT EXISTS securities_ref (
  ticker            TEXT PRIMARY KEY,
  company_name      TEXT,
  sector            TEXT,
  industry          TEXT,
  asset_class       TEXT,                 -- equity | etf | adr | fund | other
  is_etf            INTEGER NOT NULL DEFAULT 0,
  is_adr            INTEGER NOT NULL DEFAULT 0,
  country           TEXT,                 -- ISO-2, e.g. 'US'
  state_hq          TEXT,                 -- US state abbrev (HQ)
  state_of_incorp   TEXT,                 -- SEC EDGAR stateOfIncorporation
  exchange          TEXT,
  exchange_short    TEXT,                 -- 'NASDAQ' | 'NYSE' | 'OTC' | …
  currency          TEXT,
  market_cap        INTEGER,             -- USD
  market_cap_bucket TEXT,                 -- mega | large | mid | small | micro | nano
  ipo_date          TEXT,                 -- YYYY-MM-DD
  cik               TEXT,                 -- SEC CIK (zero-padded)
  sic_code          TEXT,
  sic_description   TEXT,
  source            TEXT,                 -- 'fmp' | 'edgar' | 'fmp+edgar'
  enriched_at       TEXT,                 -- ISO timestamp of last successful enrichment
  enrichment_error  TEXT                  -- last error, else NULL
);

CREATE INDEX IF NOT EXISTS idx_secref_sector   ON securities_ref (sector);
CREATE INDEX IF NOT EXISTS idx_secref_bucket   ON securities_ref (market_cap_bucket);
CREATE INDEX IF NOT EXISTS idx_secref_enriched ON securities_ref (enriched_at);
