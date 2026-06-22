-- 0007_market_extras.sql
-- Cross-app sharing round 2: daily volume on the price series, plus two new
-- ticker+date datasets a sibling app pushes (insider Form-4 aggregates and FINRA
-- short-volume). All idempotent-friendly via IF NOT EXISTS / additive ALTER.

ALTER TABLE price_eod ADD COLUMN volume INTEGER;

-- Insider (SEC Form 4) daily aggregate, keyed by ticker+date (as-of).
CREATE TABLE IF NOT EXISTS insider_eod (
  ticker       TEXT NOT NULL,
  date         TEXT NOT NULL,
  sentiment    REAL,            -- 0..100 blended insider sentiment
  buy_filings  INTEGER,
  sell_filings INTEGER,
  buy_shares   REAL,
  sell_shares  REAL,
  owners       TEXT,            -- JSON array of owner names
  PRIMARY KEY (ticker, date)
);

-- FINRA short-volume daily, keyed by ticker+date (as-of).
CREATE TABLE IF NOT EXISTS short_volume_eod (
  ticker             TEXT NOT NULL,
  date               TEXT NOT NULL,
  short_volume_ratio REAL,      -- % of the day's volume that was short
  elevated           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ticker, date)
);
