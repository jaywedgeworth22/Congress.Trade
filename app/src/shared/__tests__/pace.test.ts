import { describe, it, expect, beforeEach } from 'vitest';
import {
  createPacer,
  getSharedFmpPacer,
  __resetSharedFmpPacerForTests,
  getSharedEdgarPacer,
  __resetSharedEdgarPacerForTests,
} from '../pace.ts';

describe('createPacer', () => {
  it('is a no-op when no cap is given (never sleeps)', async () => {
    for (const cap of [undefined, 0, -10]) {
      const pace = createPacer(cap as number | undefined);
      const t0 = Date.now();
      for (let i = 0; i < 5; i++) await pace();
      expect(Date.now() - t0).toBeLessThan(50);
    }
  });

  it('first call is immediate; subsequent calls are spaced by ~60000/maxPerMinute ms', async () => {
    const pace = createPacer(600); // 100ms min gap
    const t0 = Date.now();
    await pace(); // immediate
    expect(Date.now() - t0).toBeLessThan(50);
    await pace(); // waits ~100ms
    expect(Date.now() - t0).toBeGreaterThanOrEqual(90);
  });

  it('staggers callers that enter concurrently instead of firing them together', async () => {
    // Two consumers awaiting the gate in the same tick (e.g. house+senate via
    // Promise.all) must each claim a distinct slot, not both read one stale
    // timestamp and fire at ~0ms apart.
    const pace = createPacer(600); // 100ms min gap
    const t0 = Date.now();
    const done: number[] = [];
    await Promise.all([
      pace().then(() => done.push(Date.now() - t0)),
      pace().then(() => done.push(Date.now() - t0)),
    ]);
    done.sort((a, b) => a - b);
    expect(done[0]).toBeLessThan(50); // first slot immediate
    expect(done[1]).toBeGreaterThanOrEqual(90); // second slot ~100ms later
  });
});

describe('getSharedFmpPacer', () => {
  beforeEach(() => __resetSharedFmpPacerForTests());

  it('returns the SAME instance across calls with the same maxPerMinute', () => {
    const a = getSharedFmpPacer(285);
    const b = getSharedFmpPacer(285);
    expect(a).toBe(b);
  });

  it('is a shared gate: two "consumers" drawing from it are spaced together', async () => {
    // First init wins; a large-gap pacer proves both consumers share one clock.
    const enrichmentPace = getSharedFmpPacer(600); // 100ms min gap
    const pricesPace = getSharedFmpPacer(600); // same instance
    const t0 = Date.now();
    await enrichmentPace(); // immediate
    await pricesPace(); // waits ~100ms because it shares enrichment's last-call time
    expect(Date.now() - t0).toBeGreaterThanOrEqual(90);
  });

  it('rebuilds the pacer if the maxPerMinute ceiling changes (Infisical-live semantics)', () => {
    const first = getSharedFmpPacer(0); // no-op pacer memoized
    const second = getSharedFmpPacer(600); // 600 differs from 0, so rebuilds
    expect(second).not.toBe(first);
  });
});

describe('getSharedEdgarPacer', () => {
  beforeEach(() => __resetSharedEdgarPacerForTests());

  it('returns the SAME instance across calls with the same maxPerMinute', () => {
    const a = getSharedEdgarPacer(300);
    const b = getSharedEdgarPacer(300);
    expect(a).toBe(b);
  });

  it('paces calls independently of the FMP pacer (separate budget/clock)', async () => {
    __resetSharedFmpPacerForTests();
    const edgarPace = getSharedEdgarPacer(600); // 100ms min gap
    const fmpPace = getSharedFmpPacer(600); // 100ms min gap, but a DIFFERENT clock
    const t0 = Date.now();
    await edgarPace(); // immediate
    await new Promise((r) => setTimeout(r, 30));
    await fmpPace(); // immediate too — its own clock hasn't been touched yet
    expect(Date.now() - t0).toBeLessThan(80);
  });

  it('rebuilds the pacer if the maxPerMinute ceiling changes (Infisical-live semantics)', () => {
    const first = getSharedEdgarPacer(0); // no-op pacer memoized
    const second = getSharedEdgarPacer(600); // 600 differs from 0, so rebuilds
    expect(second).not.toBe(first);
  });
});
