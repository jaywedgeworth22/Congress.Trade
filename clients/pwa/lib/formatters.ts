const fullUsd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

const compactUsd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
  notation: 'compact',
  compactDisplay: 'short',
});

const shortUtcDate = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

export function formatAmount(min: number | null, max: number | null): string {
  if (min == null && max == null) return 'Undisclosed';
  if (min != null && max == null) return `${fullUsd.format(min)}+`;
  if (min == null && max != null) return `Up to ${fullUsd.format(max)}`;
  return `${fullUsd.format(min!)} - ${fullUsd.format(max!)}`;
}

export function formatEstimatedValue(value: number | null): string {
  return value == null ? 'Unknown' : `Est. ${compactUsd.format(value)}`;
}

export function formatShortDate(value: string | null): string {
  if (!value) return 'Unavailable';
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? value : shortUtcDate.format(date);
}

export function reportingLagDays(tradeDate: string | null, filedDate: string | null): number | null {
  if (!tradeDate || !filedDate) return null;
  const trade = new Date(`${tradeDate.slice(0, 10)}T00:00:00Z`);
  const filed = new Date(`${filedDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(trade.getTime()) || Number.isNaN(filed.getTime())) return null;
  return Math.round((filed.getTime() - trade.getTime()) / 86_400_000);
}

export function complianceInfo(days: number | null): { text: string; className: string } {
  if (days == null) return { text: 'Unknown', className: 'compliance-unknown' };
  if (days < 0) return { text: `${Math.abs(days)} days early`, className: 'compliance-green' };
  if (days < 15) return { text: `${days} days`, className: 'compliance-green' };
  if (days <= 45) return { text: `${days} days`, className: 'compliance-yellow' };
  return { text: `${days} days`, className: 'compliance-red' };
}
