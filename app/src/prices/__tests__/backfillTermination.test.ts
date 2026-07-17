/**
 * src/prices/__tests__/backfillTermination.test.ts
 *
 * Behavioral tests (real migrated SQLite) for the fixes that let the
 * /api/admin/backfill-market loop terminate instead of running forever:
 *   - marketPending.prices excludes negative-cached (price_unavailable) tickers
 *     and uses NOT EXISTS, so it can reach 0 → done:true becomes reachable.
 *   - selectTickersNeedingPrices skips fresh tickers (latest_price_date >= last
 *     trading day) and negative-cached ones (within the re-check TTL), while still
 *     retrying ones whose negative-cache has aged past the TTL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// hasConfiguredKeyedEnrichmentProvider (used by marketPending) resolves secrets;
// with none configured it must report "no keyed provider" deterministically.
// Partial mock so every other export the route graph pulls in stays real.
vi.mock('../../secrets/infisical', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../secrets/infisical')>()),
  resolveSecrets: vi.fn(async () => ({})),
}));

import type { Env } from '../../shared/types';
import { marketPending } from '../../admin/routes';
import { PRICE_BACKFILL_TERMINATION_SCHEMA_STATEMENTS } from '../../admin/migrations';
import {
  selectTickersNeedingPrices,
  lastTradingDay,
  priceUnavailableCutoffIso,
} from '../service';
import { openMigratedD1, type SqliteDatabase } from './sqliteD1';

let db: SqliteDatabase;
let env: Env;
let close: () => void;

beforeEach(async () => {
  const opened = await openMigratedD1();
  db = opened.db;
  close = opened.close;
  env = { DB: opened.d1 } as unknown as Env;
});
afterEach(() => close());

/** Seed a traded (dated) ticker + its securities_ref row. */
function seedTicker(
  ticker: string,
  sr: {
    enrichedAt?: string | null;
    latestPriceDate?: string | null;
    priceUnavailable?: 0 | 1;
    priceCheckedAt?: string | null;
  } = {},
): void {
  db.prepare(
    `INSERT INTO transactions (id, ticker, tx_date, source, created_at)
     VALUES (?, ?, '2026-01-05', 'primary', '2026-01-05T00:00:00Z')`,
  ).run(`tx-${ticker}`, ticker);
  db.prepare(
    `INSERT INTO securities_ref (ticker, enriched_at, latest_price_date, price_unavailable, price_checked_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    ticker,
    sr.enrichedAt ?? '2026-01-01T00:00:00Z',
    sr.latestPriceDate ?? null,
    sr.priceUnavailable ?? 0,
    sr.priceCheckedAt ?? null,
  );
}

function seedPriceRows(ticker: string, dates: string[]): void {
  for (const d of dates) {
    db.prepare('INSERT INTO price_eod (ticker, date, close) VALUES (?, ?, 100)').run(ticker, d);
  }
}

describe('marketPending — done:true is reachable', () => {
  it('excludes negative-cached tickers so prices reaches 0 when only priced + unavailable remain', async () => {
    // Fully priced + enriched → not pending on either axis.
    seedTicker('AAA', { latestPriceDate: '2026-07-13' });
    seedPriceRows('AAA', ['2026-07-10', '2026-07-13']);
    // Un-priceable: no price_eod row, marked unavailable within the TTL.
    seedTicker('DEAD', {
      priceUnavailable: 1,
      priceCheckedAt: new Date().toISOString(),
    });

    expect(await marketPending(env)).toEqual({ enrich: 0, prices: 0 });
  });

  it('still counts genuinely missing tickers and ones whose negative-cache aged out', async () => {
    seedTicker('MISS'); // no price_eod, not unavailable → pending
    seedTicker('AAA', { latestPriceDate: '2026-07-13' });
    seedPriceRows('AAA', ['2026-07-13']);
    seedTicker('DEAD', { priceUnavailable: 1, priceCheckedAt: new Date().toISOString() }); // excluded
    seedTicker('STALEUNAVAIL', { priceUnavailable: 1, priceCheckedAt: '2000-01-01T00:00:00Z' }); // TTL expired → pending again

    expect((await marketPending(env)).prices).toBe(2); // MISS + STALEUNAVAIL
  });

  it('uses NOT EXISTS so a ticker with many cached rows is never counted as missing', async () => {
    seedTicker('BIG', { latestPriceDate: '2026-07-13' });
    seedPriceRows('BIG', ['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10']);
    expect((await marketPending(env)).prices).toBe(0);
    // Guard the query shape itself: the anti-join must be an index-seekable
    // NOT EXISTS, never the row-materializing `LEFT JOIN ... WHERE pe.ticker IS NULL`.
    expect(marketPending.toString()).toContain('NOT EXISTS');
    expect(marketPending.toString()).not.toContain('pe.ticker IS NULL');
  });
});

describe('selectTickersNeedingPrices — no perpetual re-selection', () => {
  const NOW = new Date('2026-07-14T12:00:00Z'); // Tuesday
  const FRESH_THROUGH = lastTradingDay(NOW); // Monday 2026-07-13
  const CUTOFF = priceUnavailableCutoffIso(NOW); // 2026-06-14

  it('drops fresh (latest_price_date == last trading day), keeps stale/never/expired-unavailable', async () => {
    seedTicker('FRESH', { latestPriceDate: FRESH_THROUGH }); // == Monday → not stale
    seedTicker('STALE', { latestPriceDate: '2026-07-01' }); // older → stale
    seedTicker('NEVER', { latestPriceDate: null }); // never priced
    seedTicker('DEADRECENT', {
      latestPriceDate: null,
      priceUnavailable: 1,
      priceCheckedAt: '2026-07-10T00:00:00Z', // within TTL → excluded
    });
    seedTicker('DEADOLD', {
      latestPriceDate: null,
      priceUnavailable: 1,
      priceCheckedAt: '2026-05-01T00:00:00Z', // before cutoff → retry
    });

    const picked = await selectTickersNeedingPrices(env, 50, {
      freshThrough: FRESH_THROUGH,
      unavailableCutoff: CUTOFF,
    });
    expect(new Set(picked)).toEqual(new Set(['STALE', 'NEVER', 'DEADOLD']));
  });

  it('with the real clock, a ticker carrying the last trading day is not re-selected', async () => {
    seedTicker('CUR', { latestPriceDate: lastTradingDay() });
    expect(await selectTickersNeedingPrices(env, 50)).toEqual([]);
  });
});

describe('0043 migration backfill', () => {
  it('seeds latest_price_date AND current_price from cached closes for anchor-less rows', () => {
    // A row that was imported closes-only under the OLD handler: cached closes but
    // null latest_price_date / current_price.
    db.prepare(
      "INSERT INTO price_eod (ticker, date, close) VALUES ('OLDIMP','2026-07-14',10),('OLDIMP','2026-07-15',12)",
    ).run();
    db.prepare("INSERT INTO securities_ref (ticker) VALUES ('OLDIMP')").run();

    // Re-run the migration's idempotent data backfill against the seeded rows (the
    // ALTER/CREATE parts already ran on the empty DB at open).
    for (const sql of PRICE_BACKFILL_TERMINATION_SCHEMA_STATEMENTS) {
      if (sql.trim().startsWith('UPDATE')) db.exec(sql);
    }

    const row = db
      .prepare(
        'SELECT latest_price_date, current_price, current_price_date FROM securities_ref WHERE ticker = ?',
      )
      .get('OLDIMP');
    expect(row?.latest_price_date).toBe('2026-07-15');
    // Without the current_price backfill the now-"fresh" selector would skip this
    // ticker forever, leaving current-return analytics blank.
    expect(row?.current_price).toBe(12);
    expect(row?.current_price_date).toBe('2026-07-15');
  });
});

describe('lastTradingDay — weekend handling', () => {
  it('never returns a Saturday or Sunday and stays behind "today"', () => {
    expect(lastTradingDay(new Date('2026-07-13T12:00:00Z'))).toBe('2026-07-10'); // Mon → Fri
    expect(lastTradingDay(new Date('2026-07-12T12:00:00Z'))).toBe('2026-07-10'); // Sun → Fri
    expect(lastTradingDay(new Date('2026-07-14T12:00:00Z'))).toBe('2026-07-13'); // Tue → Mon
  });
});
