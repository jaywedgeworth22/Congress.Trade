-- 0006_prices.sql
-- Phase B2: price history + per-trade performance vs the S&P 500.
--   price_eod      : cached daily closes per ticker (append-only).
--   spx_eod        : cached S&P 500 (^GSPC) daily closes (fetched once/day).
--   tx_performance : per-trade price anchors (close on/before the trade date and
--                    the S&P on that date); "current" values are read live from
--                    securities_ref.current_price + the latest spx_eod row.
-- securities_ref gains current_price (+ date) for the live anchor. All nullable;
-- everything degrades to "—" without an FMP key.

CREATE TABLE IF NOT EXISTS price_eod (
  ticker    TEXT NOT NULL,
  date      TEXT NOT NULL,            -- YYYY-MM-DD
  close     REAL NOT NULL,            -- split/dividend-adjusted close
  PRIMARY KEY (ticker, date)
);
CREATE INDEX IF NOT EXISTS idx_price_eod_ticker_date ON price_eod (ticker, date DESC);

CREATE TABLE IF NOT EXISTS spx_eod (
  date  TEXT PRIMARY KEY,             -- YYYY-MM-DD
  close REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS tx_performance (
  tx_id          TEXT PRIMARY KEY,
  price_at_trade REAL,
  spx_at_trade   REAL,
  computed_at    TEXT
);

ALTER TABLE securities_ref ADD COLUMN current_price      REAL;
ALTER TABLE securities_ref ADD COLUMN current_price_date TEXT;
