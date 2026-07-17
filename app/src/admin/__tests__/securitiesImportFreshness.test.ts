/**
 * src/admin/__tests__/securitiesImportFreshness.test.ts
 *
 * Regression guard for the backfill-cost fix: when App B pushes prices via
 * POST /securities/import, the handler must maintain securities_ref.latest_price_date
 * (and clear the negative-cache) so the daily price refresh treats imported
 * tickers as fresh. Otherwise latest_price_date stays NULL and
 * selectTickersNeedingPrices re-selects them every run, re-igniting the exact D1
 * spend this PR stops. Runs the real route against a real migrated SQLite DB, and
 * covers the closes-only push (no currentPrice), which the current-price-only
 * maintenance alone would miss.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAdminRouter } from '../routes';
import { selectTickersNeedingPrices } from '../../prices/service';
import { openMigratedD1, type SqliteDatabase } from '../../prices/__tests__/sqliteD1';

const app = buildAdminRouter();
const AUTH_ENV = { ADMIN_TOKEN: 'admin-secret', INGEST_TOKEN: 'ingest-secret' };

let db: SqliteDatabase;
let d1: D1Database;
let close: () => void;

beforeEach(async () => {
  const opened = await openMigratedD1();
  db = opened.db;
  d1 = opened.d1;
  close = opened.close;
});
afterEach(() => close());

function seedTrade(ticker: string): void {
  db.prepare(
    `INSERT INTO transactions (id, ticker, tx_date, source, created_at)
     VALUES (?, ?, '2026-01-05', 'primary', '2026-01-05T00:00:00Z')`,
  ).run(`tx-${ticker}`, ticker);
}

function importPrices(body: unknown) {
  return app.request(
    '/securities/import',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer ingest-secret' },
      body: JSON.stringify(body),
    },
    { ...AUTH_ENV, DB: d1 } as never,
  );
}

describe('POST /securities/import — price freshness bookkeeping', () => {
  it('sets latest_price_date to the imported max (closes-only push) so the ticker is not re-selected', async () => {
    seedTrade('IMPT');

    // Before import: never priced → latest_price_date NULL → selected.
    expect(
      await selectTickersNeedingPrices({ DB: d1 } as never, 10, { freshThrough: '2026-07-15' }),
    ).toContain('IMPT');

    // Closes-only push (no currentPrice) — the case the current-price-only
    // maintenance would leave with latest_price_date NULL.
    const res = await importPrices({
      prices: [
        {
          ticker: 'IMPT',
          closes: [
            { date: '2026-07-14', close: 99 },
            { date: '2026-07-15', close: 100 },
          ],
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);

    const row = db
      .prepare('SELECT latest_price_date, price_unavailable, price_checked_at FROM securities_ref WHERE ticker = ?')
      .get('IMPT');
    expect(row?.latest_price_date).toBe('2026-07-15');
    expect(row?.price_unavailable).toBe(0);
    expect(row?.price_checked_at).toBeTruthy();

    // After import: fresh through the imported max → NOT re-selected.
    expect(
      await selectTickersNeedingPrices({ DB: d1 } as never, 10, { freshThrough: '2026-07-15' }),
    ).not.toContain('IMPT');
  });

  it('leaves latest_price_date UNCHANGED for an import with no closes and no cached rows', async () => {
    seedTrade('NOCLOSE');
    // Pre-existing freshness value with NO cached price_eod rows.
    db.prepare(
      "INSERT INTO securities_ref (ticker, latest_price_date) VALUES ('NOCLOSE', '2026-06-01')",
    ).run();

    // Empty closes + a currentPrice but no currentPriceDate: there is no cached
    // close date to derive from, so latest_price_date must NOT advance (esp. not
    // to today() or a synthetic date).
    await importPrices({ prices: [{ ticker: 'NOCLOSE', closes: [], currentPrice: 55 }] });

    const row = db
      .prepare('SELECT latest_price_date, current_price FROM securities_ref WHERE ticker = ?')
      .get('NOCLOSE');
    expect(row?.latest_price_date).toBe('2026-06-01'); // unchanged
    expect(row?.current_price).toBe(55); // current price anchor still updates
  });

  it('clears a prior negative-cache when fresh prices are imported', async () => {
    seedTrade('REVIVE');
    db.prepare(
      `INSERT INTO securities_ref (ticker, price_unavailable, price_checked_at)
       VALUES ('REVIVE', 1, '2026-06-01T00:00:00Z')`,
    ).run();

    await importPrices({
      prices: [{ ticker: 'REVIVE', closes: [{ date: '2026-07-15', close: 42 }] }],
    });

    const row = db
      .prepare('SELECT latest_price_date, price_unavailable FROM securities_ref WHERE ticker = ?')
      .get('REVIVE');
    expect(row?.price_unavailable).toBe(0);
    expect(row?.latest_price_date).toBe('2026-07-15');
  });
});
