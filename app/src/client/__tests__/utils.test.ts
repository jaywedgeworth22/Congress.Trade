/**
 * src/client/__tests__/utils.test.ts
 *
 * Pure query-string parsing unit tests for `GET /api/client/v1/feed`'s helpers
 * (no DB, no router). Added alongside the iOS punch list #2 sort/pagination
 * work: `sort=tx_date` and `offset=` were previously accepted by the shared
 * `TxQueryParams`/`buildTransactionsQuery` SQL builder (see
 * `../../delivery/__tests__/buildTransactionsQuery.test.ts`) but silently
 * dropped by this file's query-string parser before ever reaching it.
 */
import { describe, expect, it } from 'vitest';
import { asSort, filtersFromQuery } from '../utils.ts';

describe('asSort', () => {
  it('accepts tx_date alongside the existing published/cursor keys', () => {
    expect(asSort('tx_date')).toBe('tx_date');
    expect(asSort('published')).toBe('published');
    expect(asSort('cursor')).toBe('cursor');
  });

  it('falls back to undefined (backend default: cursor order) for unknown values', () => {
    expect(asSort('amount')).toBeUndefined();
    expect(asSort(undefined)).toBeUndefined();
    expect(asSort('')).toBeUndefined();
  });
});

describe('filtersFromQuery offset', () => {
  it('parses a numeric offset= for snapshot page navigation', () => {
    const params = filtersFromQuery({ offset: '150' } as Record<string, string>);
    expect(params.offset).toBe(150);
  });

  it('omits offset when absent so the query builder defaults to page 1', () => {
    const params = filtersFromQuery({} as Record<string, string>);
    expect(params.offset).toBeUndefined();
  });

  it('threads sort=tx_date through to TxQueryParams', () => {
    const params = filtersFromQuery({ sort: 'tx_date', order: 'desc' } as Record<string, string>);
    expect(params.sort).toBe('tx_date');
    expect(params.order).toBe('desc');
  });
});
