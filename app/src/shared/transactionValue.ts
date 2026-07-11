/**
 * Materialized estimated transaction value used by feed/client aggregates.
 * Keep the SQL backfill in 0029_est_value.sql and POST /api/admin/migrate in
 * lockstep with this function.
 */
export function estimateTransactionValue(
  amountMin: number | null | undefined,
  amountMax: number | null | undefined,
): number {
  if (amountMin == null && amountMax == null) return 0;
  if (amountMin == null) return amountMax as number;
  if (amountMax == null) return amountMin;
  return (amountMin + amountMax) / 2;
}
