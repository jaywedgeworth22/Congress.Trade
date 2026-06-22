/**
 * src/delivery/__tests__/buildTransactionsQuery.test.ts
 *
 * Unit tests for the GET /transactions cursor query builder. Pure + deterministic
 * (no DB), so we assert on the generated SQL shape and bound parameter order.
 */

import { describe, it, expect } from 'vitest';
import {
  buildTransactionsQuery,
  buildTransactionsCountQuery,
  DEFAULT_TX_LIMIT,
  MAX_TX_LIMIT,
  type TxQueryParams,
} from '../rows';

describe('buildTransactionsQuery', () => {
  it('always filters cursor_seq > since (defaulting since to 0) and orders ASC', () => {
    const q = buildTransactionsQuery({});
    expect(q.sql).toContain('t.cursor_seq > ?');
    expect(q.sql).toContain('ORDER BY t.cursor_seq ASC');
    expect(q.params).toEqual([0]);
    expect(q.limit).toBe(DEFAULT_TX_LIMIT);
  });

  it('uses the supplied since cursor as the first bound param', () => {
    const q = buildTransactionsQuery({ since: 1234 });
    expect(q.params[0]).toBe(1234);
  });

  it('upper-cases ticker and appends it in WHERE/param order', () => {
    const q = buildTransactionsQuery({ since: 5, ticker: 'aapl' });
    expect(q.sql).toContain('t.ticker = ?');
    expect(q.params).toEqual([5, 'AAPL']);
  });

  it('filters by member (filer_id)', () => {
    const q = buildTransactionsQuery({ member: 'M000001' });
    expect(q.sql).toContain('t.filer_id = ?');
    expect(q.params).toEqual([0, 'M000001']);
  });

  it('filters by tx type', () => {
    const q = buildTransactionsQuery({ type: 'S' });
    expect(q.sql).toContain('t.tx_type = ?');
    expect(q.params).toEqual([0, 'S']);
  });

  it('resolves chamber via the filers table (authoritative for seed data)', () => {
    const q = buildTransactionsQuery({ chamber: 'senate' });
    // filers is the authoritative chamber source; seed trades have a filers
    // row but no filings row. We still LEFT JOIN filings and COALESCE so live
    // rows resolve when filer meta is missing.
    expect(q.sql).toContain('LEFT JOIN filers fl ON fl.bioguide_id = t.filer_id');
    expect(q.sql).toContain('LEFT JOIN filings f ON f.doc_id = t.doc_id');
    expect(q.sql).toContain('COALESCE(fl.chamber, f.chamber) = ?');
    expect(q.params).toEqual([0, 'senate']);
  });

  it('selects the resolved chamber + member name alongside t.*', () => {
    const q = buildTransactionsQuery({});
    expect(q.sql).toContain('SELECT t.*, COALESCE(fl.chamber, f.chamber) AS __chamber');
    expect(q.sql).toContain('fl.full_name AS __member_name');
  });

  it('composes all filters in a stable param order (since, ticker, member, type, chamber)', () => {
    const params: TxQueryParams = {
      since: 10,
      ticker: 'msft',
      member: 'M000001',
      type: 'P',
      chamber: 'house',
    };
    const q = buildTransactionsQuery(params);
    expect(q.params).toEqual([10, 'MSFT', 'M000001', 'P', 'house']);
    // WHERE clauses AND-ed together.
    expect(q.sql).toContain(' AND ');
  });

  it('applies the default limit when none/invalid is given', () => {
    expect(buildTransactionsQuery({}).limit).toBe(DEFAULT_TX_LIMIT);
    expect(buildTransactionsQuery({ limit: 0 }).limit).toBe(DEFAULT_TX_LIMIT);
    expect(buildTransactionsQuery({ limit: -5 }).limit).toBe(DEFAULT_TX_LIMIT);
  });

  it('honors a valid explicit limit and embeds it in the SQL', () => {
    const q = buildTransactionsQuery({ limit: 25 });
    expect(q.limit).toBe(25);
    expect(q.sql).toContain('LIMIT 25');
  });

  it('caps the limit at MAX_TX_LIMIT', () => {
    const q = buildTransactionsQuery({ limit: 10_000 });
    expect(q.limit).toBe(MAX_TX_LIMIT);
    expect(q.sql).toContain(`LIMIT ${MAX_TX_LIMIT}`);
  });

  it('does not interpolate untrusted values directly (ticker/member are bound, not inlined)', () => {
    const q = buildTransactionsQuery({ ticker: "'; DROP TABLE transactions;--" });
    // The malicious string must appear only as a bound parameter, never in SQL.
    expect(q.sql).not.toContain('DROP TABLE');
    expect(q.params).toContain("'; DROP TABLE TRANSACTIONS;--");
  });
});

describe('buildTransactionsCountQuery', () => {
  it('counts ALL rows ignoring the cursor backstop', () => {
    const q = buildTransactionsCountQuery({ since: 1234 });
    expect(q.sql).toContain('SELECT COUNT(*) AS total');
    // No cursor clause and no since param: total spans the whole filtered set.
    expect(q.sql).not.toContain('cursor_seq');
    expect(q.params).toEqual([]);
  });

  it('reuses the same ticker/member/type filters (minus the cursor)', () => {
    const q = buildTransactionsCountQuery({
      since: 99,
      ticker: 'msft',
      member: 'M000001',
      type: 'P',
    });
    expect(q.sql).toContain('t.ticker = ?');
    expect(q.sql).toContain('t.filer_id = ?');
    expect(q.sql).toContain('t.tx_type = ?');
    expect(q.params).toEqual(['MSFT', 'M000001', 'P']);
  });

  it('filters chamber via the filers table (COALESCE), same as the page query', () => {
    const q = buildTransactionsCountQuery({ chamber: 'senate' });
    expect(q.sql).toContain('LEFT JOIN filers fl ON fl.bioguide_id = t.filer_id');
    expect(q.sql).toContain('COALESCE(fl.chamber, f.chamber) = ?');
    expect(q.params).toEqual(['senate']);
  });

  it('emits no WHERE clause when there are no filters', () => {
    const q = buildTransactionsCountQuery({});
    expect(q.sql).not.toContain('WHERE');
    expect(q.params).toEqual([]);
  });
});
