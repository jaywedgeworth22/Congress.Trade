/**
 * src/prices/__tests__/pricesRefresh.test.ts
 *
 * Behavioral tests for runPriceRefresh (real migrated SQLite + a stubbed FMP
 * client): the negative-cache write on an empty EOD fetch, the latest_price_date
 * bookkeeping on success, and the incremental fetch window that stops the price
 * refresh from re-downloading each ticker's entire multi-year history every pass.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Shared, hoisted state the '../fmp' mock reads/writes (vi.mock is hoisted above
// imports, so it can't close over ordinary module-scope locals).
const h = vi.hoisted(() => ({
  eodCalls: [] as Array<{ symbol: string; from: string; to: string }>,
  responses: new Map<string, Array<{ date: string; close: number }>>(),
  // Symbols whose fetch throws — simulating the client's new behavior of throwing
  // on transient/global failures (401/402/403/429/5xx) rather than returning [].
  errors: new Set<string>(),
}));

vi.mock('../../secrets/infisical', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../secrets/infisical')>()),
  resolveSecrets: vi.fn(async () => ({})),
}));

// Replace the real FMP client (network) with a deterministic recorder. The
// symbol/from/to it receives are exactly what runPriceRefresh asked for.
vi.mock('../fmp', () => ({
  buildFmpPriceClient: () => ({
    eodHistory: async (symbol: string, from: string, to: string) => {
      h.eodCalls.push({ symbol, from, to });
      if (h.errors.has(symbol)) throw new Error('FMP_HTTP_429');
      return h.responses.get(symbol) ?? [];
    },
    spxHistory: async (from: string, to: string) => {
      h.eodCalls.push({ symbol: 'SPY', from, to });
      if (h.errors.has('SPY')) throw new Error('FMP_HTTP_429');
      return h.responses.get('SPY') ?? [];
    },
  }),
}));

import type { Env } from '../../shared/types';
import { runPriceRefresh } from '../service';
import { openMigratedD1, type SqliteDatabase } from './sqliteD1';

let db: SqliteDatabase;
let env: Env;
let close: () => void;

beforeEach(async () => {
  h.eodCalls.length = 0;
  h.responses.clear();
  h.errors.clear();
  const opened = await openMigratedD1();
  db = opened.db;
  close = opened.close;
  env = {
    DB: opened.d1,
    FMP_API_KEY: 'test-key',
    // getDailyUsed/addDailyUsed hit CONFIG_KV; a tolerant stub keeps the FMP
    // budget path working without a real KV binding.
    CONFIG_KV: { get: async () => null, put: async () => {} },
  } as unknown as Env;
});
afterEach(() => close());

function seedTrade(id: string, ticker: string, txDate: string): void {
  db.prepare(
    `INSERT INTO transactions (id, ticker, tx_date, source, created_at)
     VALUES (?, ?, ?, 'primary', ?)`,
  ).run(id, ticker, txDate, `${txDate}T00:00:00Z`);
}

function srRow(ticker: string): Record<string, unknown> | undefined {
  return db
    .prepare(
      `SELECT price_unavailable, price_checked_at, latest_price_date, current_price, current_price_date
         FROM securities_ref WHERE ticker = ?`,
    )
    .get(ticker);
}

describe('runPriceRefresh — negative-cache on empty history', () => {
  it('marks a never-cached ticker price_unavailable on a CONFIRMED-empty (no-throw) response', async () => {
    seedTrade('t1', 'DEAD', '2026-01-05'); // delisted/foreign → provider returns [] (no throw)
    const res = await runPriceRefresh(env, { max: 10 });

    const row = srRow('DEAD');
    expect(row?.price_unavailable).toBe(1);
    expect(row?.price_checked_at).toBeTruthy();
    expect(row?.latest_price_date).toBeNull();
    expect(res.tickersPriced).toBe(0);
    // No price rows were written for an un-priceable ticker.
    expect(db.prepare('SELECT COUNT(*) AS n FROM price_eod WHERE ticker = ?').get('DEAD')).toEqual({
      n: 0,
    });
  });

  it('does NOT negative-cache when the provider fetch THROWS (transient error) — retry next cycle', async () => {
    seedTrade('t1', 'FLAKY', '2026-01-05');
    h.errors.add('FLAKY'); // simulate 429/5xx/auth failure → client throws

    const res = await runPriceRefresh(env, { max: 10 });

    // No securities_ref row was created and no negative-cache written: a transient
    // outage must not lock a priceable ticker out for the 30-day TTL.
    expect(srRow('FLAKY')).toBeUndefined();
    expect(res.errors.some((e) => e.includes('FLAKY'))).toBe(true);
  });

  it('does not write the negative-cache on a dry run', async () => {
    seedTrade('t1', 'DEAD', '2026-01-05');
    await runPriceRefresh(env, { max: 10, dryRun: true });
    expect(srRow('DEAD')).toBeUndefined();
  });
});

// Dates relative to the real clock so the "fresh close" assertions don't rot as
// time passes (the stalled-listing check compares against isoDaysAgo(14)).
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

describe('runPriceRefresh — successful fetch bookkeeping', () => {
  it('caches closes, records latest_price_date, and clears any prior negative-cache', async () => {
    const d1 = daysAgo(1);
    const d2 = daysAgo(2);
    seedTrade('t2', 'AAPL', '2026-01-05');
    // Pre-mark it unavailable to prove a fresh successful fetch clears the flag.
    db.prepare(
      `INSERT INTO securities_ref (ticker, price_unavailable, price_checked_at)
       VALUES ('AAPL', 1, '2026-06-01T00:00:00Z')`,
    ).run();
    h.responses.set('AAPL', [
      { date: d1, close: 200 },
      { date: d2, close: 198 },
    ]);

    await runPriceRefresh(env, { max: 10 });

    const row = srRow('AAPL');
    expect(row?.price_unavailable).toBe(0); // recent close → not stalled
    expect(row?.latest_price_date).toBe(d1);
    expect(row?.current_price).toBe(200);
    expect(row?.current_price_date).toBe(d1);
    const rows = db
      .prepare('SELECT date FROM price_eod WHERE ticker = ? ORDER BY date')
      .all('AAPL');
    expect(rows.map((r) => r.date)).toEqual([d2, d1]);
  });

  it('negative-caches a delisted ticker whose newest close is weeks stale (non-empty fetch)', async () => {
    seedTrade('t2b', 'GONE', '2019-01-05'); // trades exist, but the series stopped
    db.prepare(
      // stale latest_price_date → selected; the provider still returns its OLD closes.
      "INSERT INTO securities_ref (ticker, latest_price_date, enriched_at) VALUES ('GONE', '2020-01-15', '2020-01-01T00:00:00Z')",
    ).run();
    h.responses.set('GONE', [{ date: '2020-01-15', close: 50 }]); // newest close is years old

    await runPriceRefresh(env, { max: 10 });

    const row = srRow('GONE');
    // Marked unavailable (TTL-bounded) so it stops being re-selected + re-fetched
    // every day, even though the fetch was non-empty. latest_price_date/current
    // price still reflect the last real close.
    expect(row?.price_unavailable).toBe(1);
    expect(row?.latest_price_date).toBe('2020-01-15');
    expect(row?.current_price).toBe(50);
  });
});

describe('runPriceRefresh — incremental fetch window (Fix 3)', () => {
  it('backfills from the oldest trade when the cache does not yet cover it', async () => {
    seedTrade('t3', 'MSFT', '2012-03-01'); // ancient first trade
    // Cache is a single recent close → its earliest cached date (2026-07-01) is
    // AFTER the oldest trade, so there is a historical gap to backfill.
    db.prepare("INSERT INTO price_eod (ticker, date, close) VALUES ('MSFT', '2026-07-01', 300)").run();
    // latest_price_date far in the past → guaranteed stale → selected regardless of run date.
    db.prepare(
      `INSERT INTO securities_ref (ticker, latest_price_date, enriched_at)
       VALUES ('MSFT', '2020-01-01', '2020-01-01T00:00:00Z')`,
    ).run();
    h.responses.set('MSFT', [{ date: '2026-07-11', close: 305 }]);

    await runPriceRefresh(env, { max: 10 });

    const call = h.eodCalls.find((c) => c.symbol === 'MSFT');
    // Gap below the cache → fetch from the oldest trade (2012-03-01 − 7d) so its
    // trade/filing anchors can be computed.
    expect(call?.from).toBe('2012-02-23');
  });

  it('uses the narrow 7-day window once the cache already covers the oldest trade', async () => {
    seedTrade('t3b', 'IBM', '2026-06-10'); // oldest trade
    // Cache spans from BEFORE the oldest trade to a recent close → no gap.
    db.prepare("INSERT INTO price_eod (ticker, date, close) VALUES ('IBM', '2026-06-01', 100)").run();
    db.prepare("INSERT INTO price_eod (ticker, date, close) VALUES ('IBM', '2026-07-01', 110)").run();
    db.prepare(
      `INSERT INTO securities_ref (ticker, latest_price_date, enriched_at)
       VALUES ('IBM', '2020-01-01', '2020-01-01T00:00:00Z')`,
    ).run();
    h.responses.set('IBM', [{ date: '2026-07-11', close: 115 }]);

    await runPriceRefresh(env, { max: 10 });

    const call = h.eodCalls.find((c) => c.symbol === 'IBM');
    // No gap (cached min 2026-06-01 <= oldest trade) → narrow window off the cached
    // max (2026-07-01 − 7d), NOT a full re-download of the multi-year history.
    expect(call?.from).toBe('2026-06-24');
  });

  it('fetches SPX covering both the cached spx close and the oldest trade date', async () => {
    seedTrade('t4', 'NVDA', '2026-01-05'); // oldest trade
    db.prepare("INSERT INTO spx_eod (date, close) VALUES ('2026-07-02', 5000)").run();
    h.responses.set('SPY', [{ date: '2026-07-11', close: 5100 }]);
    h.responses.set('NVDA', [{ date: '2026-07-11', close: 120 }]);

    await runPriceRefresh(env, { max: 10 });

    const spy = h.eodCalls.find((c) => c.symbol === 'SPY');
    // min(cached spx 2026-07-02, oldest trade 2026-01-05) − 7d = 2025-12-29, so
    // older trades can still get spx_at_trade/spx_at_filing anchors.
    expect(spy?.from).toBe('2025-12-29');
  });

  it('fetches SPX from just the cached overlap once the series already covers the oldest trade', async () => {
    seedTrade('t5', 'NVDA', '2026-06-10'); // oldest trade
    // SPX cache spans from BEFORE the oldest trade to a recent close → no gap.
    db.prepare("INSERT INTO spx_eod (date, close) VALUES ('2026-06-01', 4900)").run();
    db.prepare("INSERT INTO spx_eod (date, close) VALUES ('2026-07-02', 5000)").run();
    h.responses.set('SPY', [{ date: '2026-07-11', close: 5100 }]);
    h.responses.set('NVDA', [{ date: '2026-07-11', close: 120 }]);

    await runPriceRefresh(env, { max: 10 });

    const spy = h.eodCalls.find((c) => c.symbol === 'SPY');
    // No gap (cached min 2026-06-01 <= oldest trade) → narrow window off cached max
    // (2026-07-02 − 7d = 2026-06-25), not a full re-download of the series.
    expect(spy?.from).toBe('2026-06-25');
  });
});
