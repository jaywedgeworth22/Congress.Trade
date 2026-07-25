export type ChamberFilter = '' | 'house' | 'senate' | 'executive';

const CHAMBER_LABELS: Record<Exclude<ChamberFilter, ''>, string> = {
  house: 'House',
  senate: 'Senate',
  executive: 'Executive',
};

export interface AmountBracket {
  id: string;
  label: string;
  min: number;
  max: number | null;
}

export interface FeedFilters {
  ticker: string;
  memberName: string;
  chamber: ChamberFilter;
  amountBracketId: string;
}

export interface CommandBody {
  type: 'update_preferences' | 'create_subscription';
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export const AMOUNT_BRACKETS: readonly AmountBracket[] = [
  { id: '1k-15k', label: '$1k - $15k', min: 1_000, max: 15_000 },
  { id: '15k-50k', label: '$15k - $50k', min: 15_001, max: 50_000 },
  { id: '50k-100k', label: '$50k - $100k', min: 50_001, max: 100_000 },
  { id: '100k-250k', label: '$100k - $250k', min: 100_001, max: 250_000 },
  { id: '250k-500k', label: '$250k - $500k', min: 250_001, max: 500_000 },
  { id: '500k-1m', label: '$500k - $1M', min: 500_001, max: 1_000_000 },
  { id: '1m-plus', label: '$1M+', min: 1_000_001, max: null },
];

export const EMPTY_FILTERS: FeedFilters = {
  ticker: '',
  memberName: '',
  chamber: '',
  amountBracketId: '',
};

export function buildFeedPath(filters: FeedFilters): string {
  const params = new URLSearchParams({
    limit: '30',
    sort: 'published',
    order: 'desc',
  });
  const ticker = filters.ticker.trim().toUpperCase();
  const memberName = filters.memberName.trim();
  if (ticker) params.set('ticker', ticker);
  if (memberName) params.set('memberName', memberName);
  if (filters.chamber) params.set('chamber', filters.chamber);
  const bracket = AMOUNT_BRACKETS.find((item) => item.id === filters.amountBracketId);
  if (bracket) {
    params.set('minAmount', String(bracket.min));
    if (bracket.max != null) params.set('maxAmount', String(bracket.max));
  }
  return `/feed?${params.toString()}`;
}

export function filterSummary(filters: FeedFilters): string {
  const parts: string[] = [];
  const ticker = filters.ticker.trim();
  const memberName = filters.memberName.trim();
  if (ticker) parts.push(`Ticker: ${ticker.toUpperCase()}`);
  if (memberName) parts.push(`Politician: ${memberName}`);
  if (filters.chamber) parts.push(CHAMBER_LABELS[filters.chamber]);
  const bracket = AMOUNT_BRACKETS.find((item) => item.id === filters.amountBracketId);
  if (bracket) parts.push(bracket.label);
  return parts.join(' · ');
}

export function activeFilterCount(filters: FeedFilters): number {
  return Number(Boolean(filters.ticker.trim()))
    + Number(Boolean(filters.memberName.trim()))
    + Number(Boolean(filters.chamber))
    + Number(Boolean(filters.amountBracketId));
}

export function parseWatchlist(value: string): string[] {
  return Array.from(new Set(
    value
      .split(',')
      .map((ticker) => ticker.trim().toUpperCase())
      .filter(Boolean),
  ));
}

/**
 * Helper line for the Delivery form's read-only scope summary. A new
 * delivery's `filters.tickers` comes straight from the current Watchlist
 * textarea (see submitSubscription), so this mirrors the backend's
 * empty-tickers semantics: an empty/absent `tickers` array matches every
 * ticker rather than none (see `matchesFilters` and
 * `validateSubscriptionFilters` in app/src/delivery/subscriptions.ts).
 */
export function deliveryScopeHelperText(tickers: string[]): string {
  if (tickers.length === 0) {
    return 'Scoped to all tickers — your watchlist above is empty.';
  }
  const noun = tickers.length === 1 ? 'ticker' : 'tickers';
  return `Scoped to your watchlist above (${tickers.length} ${noun}).`;
}

export function commandBody(
  type: CommandBody['type'],
  payload: Record<string, unknown>,
  idempotencyKey = globalThis.crypto.randomUUID(),
): CommandBody {
  return { type, payload, idempotencyKey };
}
