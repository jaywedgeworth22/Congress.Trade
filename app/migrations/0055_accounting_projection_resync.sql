-- Final authoritative resync after 0054 installs the projection trigger.
-- Production executes migration statements one at a time, so this closes the
-- narrow race where a settlement lands after 0054's initial backfill but
-- before its trigger is installed.

INSERT INTO llm_spend_settlement_totals (day, provider, usd, updated_at)
SELECT day, provider, SUM(usd), MAX(created_at)
  FROM llm_spend_settlements
 GROUP BY day, provider
ON CONFLICT(day, provider) DO UPDATE SET
  usd = excluded.usd,
  updated_at = excluded.updated_at;
