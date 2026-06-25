-- 0010_fundamentals.sql
-- Cross-app FMP sharing, reverse direction: a sibling app pushes the
-- fundamentals + analyst-consensus it already fetched into this Worker's cache
-- (via POST /api/admin/securities/import), so App A reuses them for enrichment
-- instead of spending its own FMP quota. Both snapshots are keyed (ticker, date)
-- and upserted non-destructively (COALESCE), mirroring price_eod / insider_eod.

CREATE TABLE IF NOT EXISTS fundamentals_eod (
  ticker          TEXT NOT NULL,
  date            TEXT NOT NULL,
  pe_ratio        REAL,
  eps             REAL,
  beta            REAL,
  dividend_yield  REAL,
  week52_high     REAL,
  week52_low      REAL,
  fcf_yield       REAL,
  debt_to_equity  REAL,
  eps_growth      REAL,
  source          TEXT,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (ticker, date)
);

CREATE TABLE IF NOT EXISTS analyst_consensus (
  ticker         TEXT NOT NULL,
  date           TEXT NOT NULL,
  rating         TEXT,
  target_mean    REAL,
  target_high    REAL,
  target_low     REAL,
  target_median  REAL,
  analyst_count  INTEGER,
  strong_buy     INTEGER,
  buy            INTEGER,
  hold           INTEGER,
  sell           INTEGER,
  strong_sell    INTEGER,
  source         TEXT,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (ticker, date)
);
