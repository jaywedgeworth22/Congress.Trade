-- 0065_stock_act_status.sql
-- Per-transaction STOCK Act disclosure-lag fields. The 45-day rule: members
-- must disclose a covered transaction within 45 days of the trade. Analytics
-- already computed this lag per query; storing it once at insert (plus this
-- backfill) makes it filterable/indexable and keeps API consumers from
-- re-deriving it. Thresholds + truncation semantics must stay in sync with
-- app/src/shared/stockAct.ts.
--
-- Status classes: on_time (<=45 days, incl. negative amendment noise),
-- late (46-120), severely_late (>120). NULL dates -> NULL lag/status (unknown,
-- never guessed). Rows whose transaction-level filed_date is NULL keep NULL
-- fields; they resolve through the filings join at read time as before.

ALTER TABLE transactions ADD COLUMN disclosure_lag_days INTEGER;
ALTER TABLE transactions ADD COLUMN stock_act_status TEXT;

UPDATE transactions
   SET disclosure_lag_days = CAST(julianday(filed_date) - julianday(tx_date) AS INTEGER)
 WHERE disclosure_lag_days IS NULL
   AND filed_date IS NOT NULL
   AND tx_date IS NOT NULL;

UPDATE transactions
   SET stock_act_status = CASE
     WHEN disclosure_lag_days > 120 THEN 'severely_late'
     WHEN disclosure_lag_days > 45 THEN 'late'
     ELSE 'on_time'
   END
 WHERE stock_act_status IS NULL
   AND disclosure_lag_days IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tx_stock_act_status ON transactions (stock_act_status);
