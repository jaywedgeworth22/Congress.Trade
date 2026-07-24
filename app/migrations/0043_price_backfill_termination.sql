-- 0043_price_backfill_termination.sql
-- Make the /api/admin/backfill-market loop terminable and stop its D1 write/read
-- money leak.
--
-- Root cause: ~544 traded tickers are delisted/foreign/non-equity and the EOD
-- history API returns empty for them, so they are NEVER cached in price_eod. The
-- backfill loop's done:true depends on "traded tickers with no price_eod row == 0",
-- which those tickers make unreachable — so the loop never terminated and each
-- pass re-fetched and re-upserted full multi-year history for every ticker.
--
-- Fix: negative-cache un-priceable tickers (price_unavailable + a re-check
-- timestamp for a TTL retry) so they can be excluded from the pending/selection
-- counts, and maintain latest_price_date per ticker so selection + freshness read
-- an indexed securities_ref column instead of full-scanning the 1.43M-row
-- price_eod table. Backfill latest_price_date once from the existing cache.

ALTER TABLE securities_ref ADD COLUMN price_unavailable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE securities_ref ADD COLUMN price_checked_at TEXT;
ALTER TABLE securities_ref ADD COLUMN latest_price_date TEXT;

CREATE INDEX IF NOT EXISTS idx_secref_latest_price_date
  ON securities_ref (latest_price_date);

-- One-time backfill: seed latest_price_date from the cached series (indexed MAX
-- seek per ticker) so selection/freshness are correct immediately after migrate,
-- before the first price refresh maintains the column going forward.
UPDATE securities_ref
   SET latest_price_date = (
     SELECT MAX(pe.date) FROM price_eod pe WHERE pe.ticker = securities_ref.ticker
   )
 WHERE latest_price_date IS NULL
   AND EXISTS (SELECT 1 FROM price_eod pe WHERE pe.ticker = securities_ref.ticker);

-- Also seed current_price/current_price_date from the latest cached close for any
-- row that has cached closes but no live anchor (e.g. closes-only imports accepted
-- before the import handler populated it). Otherwise the new selector — which
-- skips rows with a fresh latest_price_date (set just above) — would never repair
-- the missing anchor, and current-return/member-performance analytics would keep
-- excluding otherwise fully-priced tickers.
UPDATE securities_ref
   SET current_price = (
         SELECT pe.close FROM price_eod pe
          WHERE pe.ticker = securities_ref.ticker
          ORDER BY pe.date DESC LIMIT 1
       ),
       current_price_date = (
         SELECT pe.date FROM price_eod pe
          WHERE pe.ticker = securities_ref.ticker
          ORDER BY pe.date DESC LIMIT 1
       )
 WHERE current_price IS NULL
   AND EXISTS (SELECT 1 FROM price_eod pe WHERE pe.ticker = securities_ref.ticker);
