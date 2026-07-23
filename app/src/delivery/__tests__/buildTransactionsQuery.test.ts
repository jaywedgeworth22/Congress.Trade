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
  buildTransactionsTodayFilingsQuery,
  mapFeedTransaction,
  mapTransaction,
  toPublicFiling,
  escapeLikePattern,
  DEFAULT_TX_LIMIT,
  MAX_TX_LIMIT,
  type TxQueryParams,
  type FeedTransactionRow,
  type TransactionRow,
} from '../rows.ts';
import type { Filing } from '../../shared/types.ts';

describe('buildTransactionsQuery', () => {
  it('always filters cursor_seq > since (defaulting since to 0) and orders by cursor ASC', () => {
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

  it('filters by politician (member/filer_id)', () => {
    const q = buildTransactionsQuery({ member: 'M000001' });
    expect(q.sql).toContain('t.filer_id = ?');
    expect(q.params).toEqual([0, 'M000001']);
  });

  it('filters by fuzzy politician name server-side', () => {
    const q = buildTransactionsQuery({ memberName: 'Pelo' });
    expect(q.sql).toContain("LOWER(COALESCE(fl.full_name, t.filer_id, '')) LIKE ?");
    expect(q.sql).toContain("ESCAPE '\\'");
    expect(q.params).toEqual([0, '%pelo%']);
  });

  it('escapes LIKE metacharacters in memberName so they are matched literally', () => {
    const q = buildTransactionsQuery({ memberName: 'A_B%C' });
    // A literal '_' must not act as a single-char wildcard, and a literal '%'
    // must not act as a multi-char wildcard.
    expect(q.params).toEqual([0, '%a\\_b\\%c%']);
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

  it('selects the resolved chamber + politician name alongside t.*', () => {
    const q = buildTransactionsQuery({});
    expect(q.sql).toContain('SELECT t.*, COALESCE(fl.chamber, f.chamber) AS __chamber');
    expect(q.sql).toContain('fl.full_name AS __member_name');
  });

  it('joins filers to project the politician name/state/headshot for the feed', () => {
    const q = buildTransactionsQuery({});
    expect(q.sql).toContain('LEFT JOIN filers fl ON fl.bioguide_id = t.filer_id');
    expect(q.sql).toContain('fl.full_name AS filer_full_name');
    expect(q.sql).toContain('fl.state AS filer_state');
    expect(q.sql).toContain('fl.photo_url AS filer_photo_url');
    expect(q.sql).toContain('f.source_url AS filing_source_url');
  });

  it('composes all filters in a stable param order', () => {
    const params: TxQueryParams = {
      since: 10,
      ticker: 'msft',
      member: 'M000001',
      type: 'P',
      chamber: 'house',
      minAmount: 15_001,
      maxAmount: 50_000,
    };
    const q = buildTransactionsQuery(params);
    expect(q.params).toEqual([10, 'MSFT', 'M000001', 'P', 'house', 15_001, 50_000]);
    expect(q.sql).toContain('t.amount_min >= ?');
    expect(q.sql).toContain('t.amount_min <= ?');
    // WHERE clauses AND-ed together.
    expect(q.sql).toContain(' AND ');
  });

  it('bounds the trade date with txDateMin (?from=) after the other filters', () => {
    const q = buildTransactionsQuery({ since: 7, ticker: 'aapl', txDateMin: '2026-03-24' });
    expect(q.sql).toContain('t.tx_date >= ?');
    // Stable order: cursor, ticker, then the trade-date floor.
    expect(q.params).toEqual([7, 'AAPL', '2026-03-24']);
  });

  it('bounds the trade date on both sides with txDateMin/txDateMax', () => {
    const q = buildTransactionsQuery({ txDateMin: '2026-01-01', txDateMax: '2026-03-31' });
    expect(q.sql).toContain('t.tx_date >= ?');
    expect(q.sql).toContain('t.tx_date <= ?');
    expect(q.params).toEqual([0, '2026-01-01', '2026-03-31']);
  });

  it('normalizes a full ISO timestamp down to YYYY-MM-DD', () => {
    const q = buildTransactionsQuery({ txDateMin: '2026-03-24T12:34:56Z' });
    expect(q.params).toEqual([0, '2026-03-24']);
  });

  it('applies the default limit when none/invalid is given', () => {
    expect(buildTransactionsQuery({}).limit).toBe(DEFAULT_TX_LIMIT);
    expect(buildTransactionsQuery({ limit: 0 }).limit).toBe(DEFAULT_TX_LIMIT);
    expect(buildTransactionsQuery({ limit: -5 }).limit).toBe(DEFAULT_TX_LIMIT);
  });

  it('honors a valid explicit limit and embeds it in the SQL', () => {
    const q = buildTransactionsQuery({ limit: 25 });
    expect(q.limit).toBe(25);
    expect(q.offset).toBe(0);
    expect(q.sql).toContain('LIMIT 25');
  });

  it('honors a non-negative offset for snapshot page navigation', () => {
    const q = buildTransactionsQuery({ limit: 25, offset: 50, order: 'desc' });
    expect(q.limit).toBe(25);
    expect(q.offset).toBe(50);
    expect(q.sql).toContain('ORDER BY t.cursor_seq DESC');
    expect(q.sql).toContain('LIMIT 25 OFFSET 50');
  });

  it('clamps negative offsets to zero and omits OFFSET 0', () => {
    const q = buildTransactionsQuery({ offset: -10 });
    expect(q.offset).toBe(0);
    expect(q.sql).not.toContain('OFFSET');
  });

  it('caps the limit at MAX_TX_LIMIT', () => {
    const q = buildTransactionsQuery({ limit: 10_000 });
    expect(q.limit).toBe(MAX_TX_LIMIT);
    expect(q.sql).toContain(`LIMIT ${MAX_TX_LIMIT}`);
  });

  it('floors a fractional limit instead of embedding it verbatim (would be invalid SQL)', () => {
    const q = buildTransactionsQuery({ limit: 50.9 });
    expect(q.limit).toBe(50);
    expect(q.sql).toContain('LIMIT 50');
    expect(q.sql).not.toContain('50.9');
  });

  it('floors BEFORE clamping so a fractional value under 1 falls back to the default, not 0', () => {
    const q = buildTransactionsQuery({ limit: 0.5 });
    expect(q.limit).toBe(DEFAULT_TX_LIMIT);
  });

  it('floors a fractional offset instead of embedding it verbatim', () => {
    const q = buildTransactionsQuery({ limit: 25, offset: 10.7 });
    expect(q.offset).toBe(10);
    expect(q.sql).toContain('OFFSET 10');
    expect(q.sql).not.toContain('10.7');
  });

  it('treats a non-finite limit (NaN/Infinity) as absent, not as literal SQL text', () => {
    expect(buildTransactionsQuery({ limit: NaN }).limit).toBe(DEFAULT_TX_LIMIT);
    expect(buildTransactionsQuery({ limit: Infinity }).limit).toBe(DEFAULT_TX_LIMIT);
  });

  it('defaults to oldest-first (ORDER BY cursor_seq ASC) when order is omitted', () => {
    const q = buildTransactionsQuery({});
    expect(q.sql).toContain('ORDER BY t.cursor_seq ASC');
    expect(q.sql).not.toContain('DESC');
  });

  it('orders newest-first (ORDER BY cursor_seq DESC) when order is "desc"', () => {
    const q = buildTransactionsQuery({ order: 'desc' });
    expect(q.sql).toContain('ORDER BY t.cursor_seq DESC');
    // The direction is a SQL literal, never a bound param — params unchanged.
    expect(q.params).toEqual([0]);
  });

  it('treats order: "asc" the same as the default (ASC)', () => {
    const q = buildTransactionsQuery({ order: 'asc' });
    expect(q.sql).toContain('ORDER BY t.cursor_seq ASC');
  });

  it('keeps the cursor backstop + filters intact in desc (snapshot) mode', () => {
    const q = buildTransactionsQuery({ since: 7, ticker: 'aapl', order: 'desc' });
    expect(q.sql).toContain('t.cursor_seq > ?');
    expect(q.sql).toContain('ORDER BY t.cursor_seq DESC');
    // order adds no bound param; same param order as the asc path.
    expect(q.params).toEqual([7, 'AAPL']);
  });

  it('can sort snapshot pages by published/imported time', () => {
    const q = buildTransactionsQuery({ sort: 'published', order: 'desc', limit: 25 });
    expect(q.sql).toContain('ORDER BY COALESCE(f.first_seen_at, f.filed_date, t.created_at, t.cursor_seq) DESC, t.cursor_seq DESC');
    expect(q.params).toEqual([0]);
  });

  it('does not interpolate untrusted values directly (ticker/member-filer are bound, not inlined)', () => {
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

  it('reuses the same ticker/member-filer/type filters (minus the cursor)', () => {
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

  it('excludes retracted rows even when no other filters are given', () => {
    const q = buildTransactionsCountQuery({});
    // The only WHERE clause is the always-on retracted (un-published) guard.
    expect(q.sql).toContain('WHERE t.deprecated_at IS NULL');
    expect(q.params).toEqual([]);
  });

  it('honors the trade-date window so the total reflects the windowed set', () => {
    const q = buildTransactionsCountQuery({ txDateMin: '2026-03-24', txDateMax: '2026-06-22' });
    expect(q.sql).toContain('t.tx_date >= ?');
    expect(q.sql).toContain('t.tx_date <= ?');
    // No cursor backstop in the count query.
    expect(q.params).toEqual(['2026-03-24', '2026-06-22']);
  });
});

describe('buildTransactionsTodayFilingsQuery', () => {
  it('counts distinct docs imported today with the same feed filters', () => {
    const q = buildTransactionsTodayFilingsQuery(
      { ticker: 'aapl', chamber: 'house' },
      '2026-06-24T12:00:00Z',
    );
    expect(q.sql).toContain('COUNT(DISTINCT t.doc_id) AS total');
    expect(q.sql).toContain('t.ticker = ?');
    expect(q.sql).toContain('COALESCE(fl.chamber, f.chamber) = ?');
    expect(q.sql).toContain('substr(COALESCE(f.first_seen_at, t.created_at), 1, 10) = ?');
    expect(q.params).toEqual(['AAPL', 'house', '2026-06-24']);
  });
});

describe('mapFeedTransaction', () => {
  function feedRow(over: Partial<FeedTransactionRow> = {}): FeedTransactionRow {
    return {
      id: 't1',
      doc_id: 'H-2024-1',
      filer_id: 'P000197',
      tx_date: '2024-01-02',
      owner: 'self',
      asset_name: 'Acme',
      ticker: 'ACME',
      asset_type: 'stock',
      tx_type: 'P',
      amount_min: 1001,
      amount_max: 15000,
      is_option: 0,
      cap_gains_over_200: 0,
      raw_text: '',
      est_value: 8000.5,
      confidence: 0.9,
      source: 'primary',
      created_at: '2024-01-03T00:00:00Z',
      cursor_seq: 5,
      filer_full_name: 'Nancy Pelosi',
      filer_state: 'CA',
      filer_photo_url: 'https://unitedstates.github.io/images/congress/225x275/P000197.jpg',
      filing_filed_date: '2024-01-01',
      filing_first_seen_at: '2024-01-02T12:00:00Z',
      filing_source_url: 'https://disclosures.example/doc.pdf',
      ...over,
    };
  }

  it('carries the joined filer identity onto the Transaction', () => {
    const tx = mapFeedTransaction(feedRow());
    expect(tx.fullName).toBe('Nancy Pelosi');
    expect(tx.state).toBe('CA');
    expect(tx.photoUrl).toContain('P000197.jpg');
    // filing timestamps for the per-row latency column
    expect(tx.filedDate).toBe('2024-01-01');
    expect(tx.firstSeenAt).toBe('2024-01-02T12:00:00Z');
    expect(tx.sourceUrl).toBe('https://disclosures.example/doc.pdf');
    // base transaction mapping still applies
    expect(tx.ticker).toBe('ACME');
    expect(tx.cursorSeq).toBe(5);
    expect((tx as typeof tx & { estValue: number | null }).estValue).toBe(8000.5);
  });

  it('canonicalizes malformed stored filer names at the API boundary', () => {
    const tx = mapFeedTransaction(feedRow({ filer_full_name: 'Richard Dean Dr McCormick' }));
    expect(tx.fullName).toBe('Richard Dean McCormick');
  });

  it('tolerates an unresolved filer (nulls pass through, never throws)', () => {
    const tx = mapFeedTransaction(
      feedRow({ filer_full_name: null, filer_state: null, filer_photo_url: null }),
    );
    expect(tx.fullName).toBeNull();
    expect(tx.state).toBeNull();
    expect(tx.photoUrl).toBeNull();
  });

  it('surfaces a NULL tx_type honestly as null, never silently defaulted to P (Purchase)', () => {
    const tx = mapFeedTransaction(feedRow({ tx_type: null }));
    expect(tx.txType).toBeNull();
  });
});

describe('mapTransaction: honest tx_type passthrough', () => {
  function txRow(over: Partial<TransactionRow> = {}): TransactionRow {
    return {
      id: 't1',
      doc_id: 'H-1',
      filer_id: 'P000197',
      tx_date: '2024-01-02',
      owner: 'self',
      asset_name: 'Acme',
      ticker: 'ACME',
      asset_type: 'stock',
      tx_type: 'P',
      amount_min: 1001,
      amount_max: 15000,
      is_option: 0,
      cap_gains_over_200: 0,
      raw_text: '',
      confidence: 0.9,
      source: 'primary',
      created_at: '2024-01-03T00:00:00Z',
      cursor_seq: 5,
      est_value: null,
      ...over,
    };
  }

  it('passes a disclosed side through unchanged', () => {
    expect(mapTransaction(txRow({ tx_type: 'S' })).txType).toBe('S');
  });

  it('passes a NULL tx_type through as null rather than defaulting to P', () => {
    expect(mapTransaction(txRow({ tx_type: null })).txType).toBeNull();
  });
});

describe('escapeLikePattern', () => {
  it('backslash-escapes %, _, and a literal backslash', () => {
    expect(escapeLikePattern('a_b%c')).toBe('a\\_b\\%c');
    expect(escapeLikePattern('C:\\path')).toBe('C:\\\\path');
  });

  it('leaves ordinary text unchanged', () => {
    expect(escapeLikePattern('Pelosi')).toBe('Pelosi');
  });
});

describe('toPublicFiling', () => {
  const fullFiling: Filing = {
    docId: 'H-2026-1',
    chamber: 'house',
    filerId: 'P000197',
    filingType: 'P',
    filedDate: '2026-06-19',
    sourceUrl: 'https://disclosures-clerk.house.gov/doc.pdf',
    rawObjectKey: 'raw/2026/H-2026-1.pdf',
    ingestStatus: 'extracted',
    docKind: 'text_pdf',
    extractor: 'openrouter-vision',
    modelVersion: 'anthropic/claude-sonnet-5',
    confidence: 0.92,
    firstSeenAt: '2026-06-20T00:00:00.000Z',
    sourceUpdatedAt: null,
    error: null,
  };

  it('strips the R2 object key, extractor/model slug, and raw error text', () => {
    const pub = toPublicFiling(fullFiling);
    expect(pub).not.toHaveProperty('rawObjectKey');
    expect(pub).not.toHaveProperty('extractor');
    expect(pub).not.toHaveProperty('modelVersion');
    expect(pub).not.toHaveProperty('error');
    expect(JSON.stringify(pub)).not.toContain('openrouter-vision');
    expect(JSON.stringify(pub)).not.toContain('claude-sonnet-5');
    expect(JSON.stringify(pub)).not.toContain('raw/2026');
  });

  it('keeps every non-internal field intact', () => {
    const pub = toPublicFiling(fullFiling);
    expect(pub).toMatchObject({
      docId: 'H-2026-1',
      chamber: 'house',
      filerId: 'P000197',
      filingType: 'P',
      filedDate: '2026-06-19',
      sourceUrl: 'https://disclosures-clerk.house.gov/doc.pdf',
      ingestStatus: 'extracted',
      docKind: 'text_pdf',
      confidence: 0.92,
      firstSeenAt: '2026-06-20T00:00:00.000Z',
    });
  });

  it('still strips a populated raw error/model slug (a failed extraction is still internal detail)', () => {
    const pub = toPublicFiling({
      ...fullFiling,
      error: 'provider timeout after 3 retries: connect ECONNREFUSED 10.0.0.1:443',
    });
    expect(JSON.stringify(pub)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(pub)).not.toContain('10.0.0.1');
  });
});
