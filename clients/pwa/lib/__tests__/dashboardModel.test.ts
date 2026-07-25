import { describe, expect, it } from 'vitest';
import {
  activeFilterCount,
  buildFeedPath,
  commandBody,
  deliveryScopeHelperText,
  EMPTY_FILTERS,
  filterSummary,
  parseWatchlist,
} from '../dashboardModel';

describe('dashboard feed model', () => {
  it('always requests a latest-first published snapshot', () => {
    const url = new URL(buildFeedPath(EMPTY_FILTERS), 'https://example.test');
    expect(url.pathname).toBe('/feed');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      limit: '30',
      sort: 'published',
      order: 'desc',
    });
  });

  it('serializes server-backed ticker, member, chamber, and amount filters', () => {
    const url = new URL(buildFeedPath({
      ticker: ' aapl ',
      memberName: ' Nancy Pelosi ',
      chamber: 'house',
      amountBracketId: '15k-50k',
    }), 'https://example.test');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      ticker: 'AAPL',
      memberName: 'Nancy Pelosi',
      chamber: 'house',
      minAmount: '15001',
      maxAmount: '50000',
    });
  });

  it('summarizes and counts only active filters', () => {
    const filters = {
      ticker: 'msft',
      memberName: '',
      chamber: 'senate' as const,
      amountBracketId: '1m-plus',
    };
    expect(activeFilterCount(filters)).toBe(3);
    expect(filterSummary(filters)).toBe('Ticker: MSFT · Senate · $1M+');
  });

  it('normalizes and deduplicates a watchlist', () => {
    expect(parseWatchlist(' aapl, MSFT, aapl, , nvda ')).toEqual(['AAPL', 'MSFT', 'NVDA']);
  });

  it('accepts an executive chamber filter and labels it distinctly from senate', () => {
    const url = new URL(buildFeedPath({ ...EMPTY_FILTERS, chamber: 'executive' }), 'https://example.test');
    expect(url.searchParams.get('chamber')).toBe('executive');
    expect(filterSummary({ ...EMPTY_FILTERS, chamber: 'executive' })).toBe('Executive');
  });

  it('summarizes delivery scope from the live watchlist, matching backend empty-tickers semantics', () => {
    expect(deliveryScopeHelperText([])).toBe('Scoped to all tickers — your watchlist above is empty.');
    expect(deliveryScopeHelperText(['AAPL'])).toBe('Scoped to your watchlist above (1 ticker).');
    expect(deliveryScopeHelperText(['AAPL', 'MSFT'])).toBe('Scoped to your watchlist above (2 tickers).');
  });

  it('keeps an explicit idempotency key attached to the intent body', () => {
    const body = commandBody('update_preferences', { watchlist: ['AAPL'] }, 'intent-uuid');
    expect(body.idempotencyKey).toBe('intent-uuid');
    expect(body).toBe(body);
  });

  it('creates a fresh UUID for each new user intent', () => {
    const first = commandBody('update_preferences', { watchlist: ['AAPL'] });
    const second = commandBody('update_preferences', { watchlist: ['AAPL'] });
    expect(first.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });
});
