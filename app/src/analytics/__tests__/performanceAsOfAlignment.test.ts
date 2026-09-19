/**
 * Board row 6c05e09b: "Excess vs S&P" subtracted the S&P move up to the LATEST
 * S&P bar (2026-08-03) from an asset whose price was frozen at 2026-07-24, so
 * every stale-priced ticker carried a benchmark-drift error equal to the market
 * move over the gap.  These run the real leaderboard / skill / per-member SQL
 * against a migrated in-memory schema and assert numerically that both legs end
 * on the same date.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMigratedD1, type SqliteDatabase } from '../../prices/__tests__/sqliteD1.ts';
import {
  buildMemberPerformanceLeaderboardQuery,
  buildMemberPerformanceQuery,
  buildMemberSkillQuery,
} from '../builders.ts';
import { aggregateMemberDualPerformance } from '../compute.ts';

let db: SqliteDatabase;

beforeEach(async () => {
  ({ db } = await openMigratedD1());
  for (const [date, close] of [['2026-07-20', 5000], ['2026-07-24', 5040], ['2026-08-03', 5100]] as const) {
    db.prepare('INSERT INTO spx_eod (date, close) VALUES (?, ?)').run(date, close);
  }
  // STALE was last priced 2026-07-24; FRESH on 2026-08-03; both moved +10% since the filing.
  db.prepare("INSERT INTO securities_ref (ticker, company_name, current_price, current_price_date) VALUES ('STALE', 'Stale Corp', 110, '2026-07-24')").run();
  db.prepare("INSERT INTO securities_ref (ticker, company_name, current_price, current_price_date) VALUES ('FRESH', 'Fresh Corp', 110, '2026-08-03')").run();
  db.prepare("INSERT INTO securities_ref (ticker, company_name, current_price) VALUES ('NODATE', 'No Date Corp', 110)").run();
  db.prepare("INSERT INTO filers (bioguide_id, chamber, full_name) VALUES ('f-stale', 'house', 'Stale Filer'), ('f-fresh', 'house', 'Fresh Filer'), ('f-nodate', 'house', 'No Date Filer')").run();
  buy('f-stale', 'STALE');
  buy('f-fresh', 'FRESH');
  buy('f-nodate', 'NODATE');
});

afterEach(() => db.close());

function buy(filerId: string, ticker: string) {
  const id = `tx-${ticker}`;
  db.prepare("INSERT INTO filings (doc_id, chamber, filer_id, filing_type, filed_date, ingest_status) VALUES (?, 'house', ?, 'P', '2026-06-01', 'persisted')").run(`doc-${ticker}`, filerId);
  db.prepare(
    `INSERT INTO transactions (id, doc_id, filer_id, tx_date, ticker, asset_type, is_option, tx_type, amount_min, amount_max, source)
     VALUES (?, ?, ?, '2026-05-25', ?, 'ST', 0, 'B', 1001, 15000, 'primary')`,
  ).run(id, `doc-${ticker}`, filerId, ticker);
  db.prepare(
    'INSERT INTO tx_performance (tx_id, price_at_trade, spx_at_trade, price_at_filing, spx_at_filing, computed_at) VALUES (?, 95, 4700, 100, 4800, ?)',
  ).run(id, '2026-08-19T00:00:00.000Z');
}

describe('performance leaderboard excess uses the S&P close on the ticker\'s own price date', () => {
  it('STALE (priced 2026-07-24) is measured against the 2026-07-24 S&P, FRESH against 2026-08-03', () => {
    const q = buildMemberPerformanceLeaderboardQuery({ window: 'all', minTrades: 1, limit: 10 });
    const rows = db.prepare(q.sql).all(...q.params) as Array<{ filer_id: string; avg_excess: number; prices_as_of: string }>;
    const by = Object.fromEntries(rows.map((r) => [r.filer_id, r]));

    // (110/100 - 1) - (5040/4800 - 1) = 0.10 - 0.05
    expect(by['f-stale'].avg_excess).toBeCloseTo(0.05, 6);
    expect(by['f-stale'].prices_as_of).toBe('2026-07-24');
    // (110/100 - 1) - (5100/4800 - 1) = 0.10 - 0.0625
    expect(by['f-fresh'].avg_excess).toBeCloseTo(0.0375, 6);
    expect(by['f-fresh'].prices_as_of).toBe('2026-08-03');
    // Before the fix STALE read 0.0375 too (benchmark drifted 1.25 points for free).
  });

  it('a ticker with no price date falls back to the latest S&P close (the old behaviour) rather than dropping out', () => {
    const q = buildMemberPerformanceLeaderboardQuery({ window: 'all', minTrades: 1, limit: 10 });
    const rows = db.prepare(q.sql).all(...q.params) as Array<{ filer_id: string; avg_excess: number }>;
    const nodate = rows.find((r) => r.filer_id === 'f-nodate');
    expect(nodate?.avg_excess).toBeCloseTo(0.0375, 6);
  });

  it('the skill query and the per-member rows use the same alignment', () => {
    const sq = buildMemberSkillQuery(['f-stale'], { window: 'all' });
    // Skill needs >= 5 scored buys; assert the aligned excess through the raw per-trade rows instead.
    expect(sq.sql).toContain('px.spx_now / p.spx_at_filing');
    const pq = buildMemberPerformanceQuery('f-stale', { window: 'all' });
    const rows = db.prepare(pq.sql).all(...pq.params) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].current_price_date).toBe('2026-07-24');
    expect(rows[0].spx_now).toBe(5040);

    const dual = aggregateMemberDualPerformance(
      rows.map((r) => ({
        isOption: false,
        txType: String(r.tx_type),
        priceAtTrade: Number(r.price_at_trade),
        spxAtTrade: Number(r.spx_at_trade),
        priceAtFiling: Number(r.price_at_filing),
        spxAtFiling: Number(r.spx_at_filing),
        currentPrice: Number(r.current_price),
        elapsedDaysSinceFiling: 80,
        currentPriceDate: String(r.current_price_date),
        spxNow: Number(r.spx_now),
      })),
      5100, // the misaligned latest close a caller might still pass
    );
    // Filing-date leg: 0.10 - (5040/4800 - 1) = 0.05, NOT 0.0375.
    expect(dual.filingDate.avgExcess).toBeCloseTo(0.05, 4);
  });
});
