-- 0012_shares_outstanding.sql
-- Store shares outstanding per security so market cap stays current off the daily
-- close we already fetch (cap = shares_outstanding * current_price) — no extra
-- enrichment API call needed to keep market_cap from going stale as price moves.
--
-- enrichment derives shares from a provider's (marketCap, price) pair or an
-- explicit shares field; the price refresh then recomputes market_cap +
-- market_cap_bucket from this column on every close update (see prices/service.ts).
--
-- Backfill: seed an approximate share count for already-enriched rows from their
-- stored snapshot cap and current price. It is refined to the exact provider
-- value the next time enrichment runs for that ticker.

ALTER TABLE securities_ref ADD COLUMN shares_outstanding REAL;

UPDATE securities_ref
   SET shares_outstanding = market_cap / current_price
 WHERE shares_outstanding IS NULL
   AND market_cap IS NOT NULL
   AND current_price IS NOT NULL
   AND current_price > 0;
