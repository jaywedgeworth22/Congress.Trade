/**
 * src/shared/stockAct.ts
 *
 * STOCK Act 45-day disclosure-lag computation. The rule: members must disclose
 * a covered transaction within 45 days. We compute the whole-day lag between
 * the trade date and the official filing date once, at insert time (and via
 * the 0064 backfill), so feed filters and API consumers read a stored field
 * instead of recomputing julianday diffs per row.
 *
 * Keep the SQL backfill in migrations/0065_stock_act_status.sql and
 * STOCK_ACT_STATUS_SCHEMA_STATEMENTS (admin/migrations.ts) in sync with the
 * thresholds and truncation semantics here.
 */

export type StockActStatus = 'on_time' | 'late' | 'severely_late';

/** Statutory disclosure window (days). */
export const STOCK_ACT_DEADLINE_DAYS = 45;
/** Lag beyond this is classified 'severely_late' (an editorial threshold — the
 *  statute only defines the 45-day deadline; 120 days ~ 4 months). */
export const STOCK_ACT_SEVERELY_LATE_DAYS = 120;

const MS_PER_DAY = 86_400_000;

/** Parse a date/datetime string to epoch ms; NaN when unparseable. */
function parseDay(value: string | null | undefined): number {
  if (!value) return NaN;
  const t = Date.parse(value.length <= 10 ? `${value.slice(0, 10)}T00:00:00Z` : value);
  return t;
}

/**
 * Whole days from trade date to filing date, truncated toward zero to match
 * SQLite's `CAST(julianday(a) - julianday(b) AS INTEGER)`. Negative values
 * (filing dated before the trade — amendments / noisy source data) are kept,
 * mirroring the SQL backfill. Returns null when either date is missing or
 * unparseable.
 */
export function computeDisclosureLagDays(
  txDate: string | null | undefined,
  filedDate: string | null | undefined,
): number | null {
  const tx = parseDay(txDate);
  const filed = parseDay(filedDate);
  if (Number.isNaN(tx) || Number.isNaN(filed)) return null;
  return Math.trunc((filed - tx) / MS_PER_DAY);
}

/**
 * Classify a lag against the STOCK Act deadline. Lags <= 45 days (including
 * negatives) are 'on_time'; 46-120 'late'; >120 'severely_late'. Null lag
 * (unknown dates) maps to null — never guessed.
 */
export function stockActStatusForLag(lagDays: number | null | undefined): StockActStatus | null {
  if (lagDays === null || lagDays === undefined || !Number.isFinite(lagDays)) return null;
  if (lagDays > STOCK_ACT_SEVERELY_LATE_DAYS) return 'severely_late';
  if (lagDays > STOCK_ACT_DEADLINE_DAYS) return 'late';
  return 'on_time';
}

/** Convenience: (txDate, filedDate) -> status in one call. */
export function computeStockActStatus(
  txDate: string | null | undefined,
  filedDate: string | null | undefined,
): StockActStatus | null {
  return stockActStatusForLag(computeDisclosureLagDays(txDate, filedDate));
}

/** Closed enum of accepted values for the public `?stockAct=` feed filter. */
export const STOCK_ACT_STATUSES: readonly StockActStatus[] = ['on_time', 'late', 'severely_late'];

export function asStockActStatus(value: string | undefined | null): StockActStatus | undefined {
  if (!value) return undefined;
  return (STOCK_ACT_STATUSES as readonly string[]).includes(value)
    ? (value as StockActStatus)
    : undefined;
}
