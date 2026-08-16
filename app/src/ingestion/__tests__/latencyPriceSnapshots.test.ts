import { describe, expect, it } from 'vitest';
import {
  addMs,
  parseFmpQuote,
  snapshotPlan,
  SNAPSHOT_STALE_MS,
} from '../latencyPriceSnapshots.ts';

describe('latency price snapshots', () => {
  it('parses FMP quote arrays and objects, rejects junk', () => {
    expect(parseFmpQuote([{ symbol: 'AAPL', price: 190.5 }])).toBe(190.5);
    expect(parseFmpQuote({ price: 12 })).toBe(12);
    expect(parseFmpQuote({ price: 0 })).toBeNull();
    expect(parseFmpQuote([])).toBeNull();
    expect(parseFmpQuote(null)).toBeNull();
  });

  it('plans CT publish, competitor publish, and +5/+30/+60 from the competitor stamp', () => {
    const plan = snapshotPlan({
      trade_hash: 'h1',
      ticker: 'nvda',
      provider: 'fmp',
      congress_first_seen_at: '2026-08-16T15:00:00.000Z',
      provider_first_seen_at: '2026-08-16T15:10:00.000Z',
      provider_published_at: null,
    });
    expect(plan.map((p) => p.event)).toEqual([
      'ct_publish',
      'provider_publish',
      'provider_plus_5m',
      'provider_plus_30m',
      'provider_plus_60m',
    ]);
    expect(plan[0]!.dueAt).toBe('2026-08-16T15:00:00.000Z');
    expect(plan[1]!.dueAt).toBe('2026-08-16T15:10:00.000Z');
    expect(plan[2]!.dueAt).toBe('2026-08-16T15:15:00.000Z');
    expect(plan[3]!.dueAt).toBe('2026-08-16T15:40:00.000Z');
    expect(plan[4]!.dueAt).toBe('2026-08-16T16:10:00.000Z');
  });

  it('prefers provider_published_at when both stamps exist', () => {
    const plan = snapshotPlan({
      trade_hash: 'h1',
      ticker: 'AAPL',
      provider: 'unusual_whales',
      congress_first_seen_at: '2026-08-16T15:00:00.000Z',
      provider_first_seen_at: '2026-08-16T15:12:00.000Z',
      provider_published_at: '2026-08-16T15:11:00.000Z',
    });
    expect(plan.find((p) => p.event === 'provider_publish')?.dueAt).toBe('2026-08-16T15:11:00.000Z');
    expect(plan.find((p) => p.event === 'provider_plus_5m')?.dueAt).toBe(addMs('2026-08-16T15:11:00.000Z', 5 * 60_000));
  });

  it('skips blank or absurd tickers', () => {
    expect(snapshotPlan({
      trade_hash: 'h1',
      ticker: null,
      provider: 'fmp',
      congress_first_seen_at: '2026-08-16T15:00:00.000Z',
      provider_first_seen_at: '2026-08-16T15:10:00.000Z',
      provider_published_at: null,
    })).toEqual([]);
    expect(snapshotPlan({
      trade_hash: 'h1',
      ticker: 'THIS-IS-NOT-A-TICKER',
      provider: 'fmp',
      congress_first_seen_at: '2026-08-16T15:00:00.000Z',
      provider_first_seen_at: '2026-08-16T15:10:00.000Z',
      provider_published_at: null,
    })).toEqual([]);
  });

  it('keeps the live-quote stale window at three minutes', () => {
    expect(SNAPSHOT_STALE_MS).toBe(180_000);
  });
});
