import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  computeNeedScout,
  LATENCY_SCOUT_SILENCE_HOURS,
  recordLatencyProbeOutcome,
  buildScoutPlan,
} from '../scoutHandoff.ts';

describe('computeNeedScout', () => {
  const nowMs = Date.parse('2026-08-10T12:00:00.000Z');

  it('clears needScout on success', () => {
    expect(
      computeNeedScout({
        nowMs,
        lastSuccessAt: '2026-08-10T11:00:00.000Z',
        lastError: null,
        kind: 'success',
      }),
    ).toEqual({ needScout: false, needScoutReason: null });
  });

  it('requires scout on error', () => {
    const r = computeNeedScout({
      nowMs,
      lastSuccessAt: '2026-08-10T11:00:00.000Z',
      lastError: 'HTTP_403',
      kind: 'error',
    });
    expect(r.needScout).toBe(true);
    expect(r.needScoutReason).toMatch(/HTTP_403/);
  });

  it('requires scout when not configured', () => {
    expect(
      computeNeedScout({
        nowMs,
        lastSuccessAt: null,
        lastError: null,
        kind: 'not_configured',
      }).needScout,
    ).toBe(true);
  });

  it('does not hand off budget_skip while still fresh', () => {
    const r = computeNeedScout({
      nowMs,
      lastSuccessAt: '2026-08-10T10:00:00.000Z', // 2h ago
      lastError: null,
      kind: 'budget_skip',
    });
    expect(r.needScout).toBe(false);
  });

  it('hands off budget_skip after silence threshold', () => {
    const old = new Date(nowMs - (LATENCY_SCOUT_SILENCE_HOURS + 1) * 3600_000).toISOString();
    const r = computeNeedScout({
      nowMs,
      lastSuccessAt: old,
      lastError: null,
      kind: 'budget_skip',
    });
    expect(r.needScout).toBe(true);
    expect(r.needScoutReason).toMatch(/quiet/);
  });

  it('disabled never needs scout', () => {
    expect(
      computeNeedScout({
        nowMs,
        lastSuccessAt: null,
        lastError: null,
        kind: 'disabled',
      }),
    ).toEqual({ needScout: false, needScoutReason: null });
  });
});

describe('recordLatencyProbeOutcome + buildScoutPlan', () => {
  const kvStore = new Map<string, string>();
  const env = {
    CONFIG_KV: {
      get: async (key: string, type?: string) => {
        const v = kvStore.get(key);
        if (v == null) return null;
        return type === 'json' ? JSON.parse(v) : v;
      },
      put: async (key: string, value: string) => {
        kvStore.set(key, value);
      },
    },
    DB: {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: [] }),
          first: async () => null,
          run: async () => ({ meta: {} }),
        }),
      }),
    },
  } as never;

  beforeEach(() => {
    kvStore.clear();
  });

  it('persists error outcomes as needScout', async () => {
    const h = await recordLatencyProbeOutcome(env, 'fmp', {
      kind: 'error',
      error: 'HTTP_429',
      fetchedRows: 0,
      now: new Date('2026-08-10T12:00:00.000Z'),
    });
    expect(h.needScout).toBe(true);
    expect(h.lastError).toBe('HTTP_429');
    expect(h.lastSource).toBe('server');
  });

  it('buildScoutPlan lists providers and raw notes', async () => {
    await recordLatencyProbeOutcome(env, 'fmp', {
      kind: 'error',
      error: 'blocked',
      now: new Date('2026-08-10T12:00:00.000Z'),
    });
    const plan = await buildScoutPlan(env, new Date('2026-08-10T12:05:00.000Z'));
    expect(plan.latency.length).toBeGreaterThanOrEqual(1);
    expect(plan.notes.some((n) => /R2/.test(n))).toBe(true);
    const fmp = plan.latency.find((p) => p.provider === 'fmp');
    expect(fmp?.needScout).toBe(true);
  });
});
