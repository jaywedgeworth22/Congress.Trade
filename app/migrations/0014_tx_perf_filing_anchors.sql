-- 0014_tx_perf_filing_anchors.sql
-- Disclosure-date (filing) performance anchors, alongside the existing trade-date
-- ones. A copy-trader could only act once a filing is PUBLIC, so the honest
-- "could you have followed this?" return is measured from the filing date, not
-- the trade date (which is private until disclosed, often 30–45+ days later).
--
--   price_at_filing : the ticker's close on/before the filing/disclosure date.
--   spx_at_filing   : the S&P 500 close on/before that same date (the benchmark
--                     at the copier's entry, so excess return = stock vs market).
--
-- Populated by the price refresh (it already has the full close history in hand).
-- Both nullable; trade-date anchors are kept for the hindsight view.

ALTER TABLE tx_performance ADD COLUMN price_at_filing REAL;
ALTER TABLE tx_performance ADD COLUMN spx_at_filing   REAL;
