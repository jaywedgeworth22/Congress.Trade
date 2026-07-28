/**
 * src/delivery/__tests__/feedXml.test.ts
 *
 * GET /feed.xml — RSS 2.0 over the existing transactions query builder.
 * Pins the content type, the newest-first query shape, and XML escaping.
 */
import { describe, it, expect } from 'vitest';
import { buildRestRouter, xmlEscape } from '../rest.ts';
import type { Env } from '../../shared/types.ts';
import type { FeedTransactionRow } from '../rows.ts';

function feedRow(over: Partial<FeedTransactionRow> = {}): FeedTransactionRow {
  return {
    id: 'tx_1',
    doc_id: 'H-2026-1',
    filer_id: 'P000197',
    tx_date: '2026-07-01',
    owner: 'self',
    asset_name: 'Acme & Sons <Corp>',
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
    created_at: '2026-07-02T12:00:00Z',
    cursor_seq: 9,
    est_value: null,
    filer_full_name: 'Nancy Pelosi',
    filer_state: 'CA',
    filer_photo_url: null,
    filing_filed_date: '2026-07-02',
    filing_first_seen_at: '2026-07-02T12:00:00Z',
    ...over,
  };
}

function makeEnv(rows: FeedTransactionRow[]): { env: Env; sql: () => string } {
  let lastFeedSql = '';
  const prepare = (sql: string) => ({
    bind() {
      return this;
    },
    async first<T>() {
      return null as T | null;
    },
    async all<T>() {
      if (/FROM transactions/i.test(sql)) {
        lastFeedSql = sql;
        return { results: rows as T[], meta: {} };
      }
      return { results: [] as T[], meta: {} };
    },
    async run() {
      return { success: true, meta: { changes: 0 } };
    },
  });
  return {
    env: { DB: { prepare } as unknown as D1Database } as unknown as Env,
    sql: () => lastFeedSql,
  };
}

describe('GET /feed.xml', () => {
  it('serves RSS 2.0 with one item per recent trade, newest first', async () => {
    const { env, sql } = makeEnv([feedRow()]);
    const app = buildRestRouter();
    const res = await app.request('http://localhost/feed.xml', {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/rss+xml');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');

    const body = await res.text();
    expect(body).toContain('<rss version="2.0">');
    expect(body).toContain('<title>Nancy Pelosi bought ACME</title>');
    expect(body).toContain('<guid isPermaLink="false">tx_1</guid>');
    expect(body).toContain('<pubDate>');
    // Asset name carries XML metacharacters — must be escaped.
    expect(body).toContain('Acme &amp; Sons &lt;Corp.&gt;');
    expect(body).not.toContain('Acme & Sons <Corp>');
    // Newest-first snapshot over the shared builder.
    expect(sql()).toContain('ORDER BY t.cursor_seq DESC');
  });

  it('passes the shared feed filters through to the query builder', async () => {
    const { env, sql } = makeEnv([]);
    const app = buildRestRouter();
    const res = await app.request('http://localhost/feed.xml?ticker=aapl', {}, env);
    expect(res.status).toBe(200);
    expect(sql()).toContain('t.ticker = ?');
    const body = await res.text();
    expect(body).not.toContain('<item>');
  });
});

describe('xmlEscape', () => {
  it('escapes all five XML metacharacters', () => {
    expect(xmlEscape(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
    expect(xmlEscape(null)).toBe('');
  });
});
