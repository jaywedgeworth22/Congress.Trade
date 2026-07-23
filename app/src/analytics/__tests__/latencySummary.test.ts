import { describe, expect, it } from 'vitest';
import { buildAnalyticsRouter } from '../routes.ts';

const app = buildAnalyticsRouter();

/**
 * Fake D1 returning two matched fmp candidates and nothing for the other
 * providers, mirroring the production race-monitor tables.
 */
function fakeDb() {
  return {
    prepare(sql: string) {
      return {
        params: [] as unknown[],
        bind(...params: unknown[]) {
          this.params = params;
          return this;
        },
        async all<T>() {
          if (/FROM disclosure_latency_candidates/i.test(sql)) {
            return {
              results: [
                {
                  provider: 'fmp',
                  status: 'matched',
                  congress_first_seen_at: '2026-06-29T14:00:00.000Z',
                  provider_first_seen_at: '2026-06-29T15:30:00.000Z',
                  provider_published_at: null,
                  match_method: 'doc-token',
                },
                {
                  provider: 'fmp',
                  status: 'matched',
                  congress_first_seen_at: '2026-06-29T10:00:00.000Z',
                  provider_first_seen_at: '2026-06-29T10:30:00.000Z',
                  provider_published_at: null,
                  match_method: 'filer-date',
                },
                {
                  provider: 'unusual_whales',
                  status: 'pending',
                  congress_first_seen_at: '2026-06-29T14:00:00.000Z',
                  provider_first_seen_at: null,
                  provider_published_at: null,
                  match_method: null,
                },
              ] as T[],
            };
          }
          return { results: [] as T[] };
        },
        async first<T>() {
          return null as T | null;
        },
        async run() {
          return { success: true, meta: { changes: 1 } };
        },
      };
    },
  } as unknown as D1Database;
}

function fakeEnv() {
  return {
    DB: fakeDb(),
    CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
  } as never;
}

function fairnessEnv() {
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const candidates = Array.from({ length: 20 }, (_, i) => ({
    provider: 'fmp',
    status: i < 10 ? 'matched' : 'pending',
    chamber: 'house',
    provider_key: i < 10 ? `fmp-key-${i}` : null,
    match_method: i < 10 ? 'doc-token' : null,
    congress_first_seen_at: old,
    provider_first_seen_at: old,
    provider_published_at: null,
    created_at: old,
    updated_at: old,
  }));
  const observations = Array.from({ length: 20 }, (_, i) => ({
    provider: 'fmp',
    chamber: 'house',
    provider_key: `fmp-key-${i}`,
    first_observed_at: old,
    last_observed_at: old,
    provider_published_at: null,
    source_url: null,
    filed_date: `2026-06-${(i + 1).toString().padStart(2, '0')}`,
    filer_name: `Pelosi ${i}`,
    payload: null,
  }));
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind() {
            return this;
          },
          async all<T>() {
            if (/FROM disclosure_latency_candidates/i.test(sql)) return { results: candidates as T[] };
            if (/FROM disclosure_provider_observations/i.test(sql)) return { results: observations as T[] };
            return { results: [] as T[] };
          },
          async first<T>() {
            return null as T | null;
          },
          async run() {
            return { success: true, meta: { changes: 1 } };
          },
        };
      },
    },
    CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
  } as never;
}

describe('GET /latency-summary (public speed scoreboard)', () => {
  it('serves aggregate provider metrics with public field names', async () => {
    const res = await app.request('http://localhost/latency-summary', {}, fakeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
    const body = (await res.json()) as {
      generatedAt: string;
      totals: { racedDisclosures: number; matched: number; comparableProviders: number };
      providers: Array<Record<string, unknown>>;
    };
    expect(body.totals.racedDisclosures).toBe(3);
    expect(body.totals.matched).toBe(2);
    const fmp = body.providers.find((p) => p.id === 'fmp');
    expect(fmp).toMatchObject({
      label: 'Financial Modeling Prep',
      candidates: 2,
      matched: 2,
      usFirstCount: 2,
      providerFirstCount: 0,
      // deltas: +5400s and +1800s -> median/avg 3600s
      medianLeadSec: 3600,
      avgLeadSec: 3600,
    });
    const uw = body.providers.find((p) => p.id === 'unusual_whales');
    expect(uw).toMatchObject({ matched: 0, medianLeadSec: null });
  });

  it('never leaks per-filing or member detail', async () => {
    const res = await app.request('http://localhost/latency-summary', {}, fakeEnv());
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toContain('doc_id');
    expect(raw).not.toContain('docId');
    expect(raw).not.toContain('filerName');
    expect(raw).not.toContain('sourceUrl');
    // No internal provider-configuration hints on the public contract.
    expect(raw).not.toContain('configured');
    expect(raw).not.toContain('requiresMembership');
  });

  it('keeps provider-only rows in the denominator and suppresses a speed claim when overlap is incomplete', async () => {
    const res = await app.request('http://localhost/latency-summary', {}, fairnessEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providers: Array<Record<string, unknown>> };
    const fmp = body.providers.find((p) => p.id === 'fmp');
    expect(fmp).toMatchObject({
      providerObserved: 20,
      maturedProviderObserved: 20,
      maturedMatched: 10,
      unmatchedProvider: 10,
      ctCoveragePct: 50,
      providerCoveragePct: 50,
      comparisonStatus: 'limited',
      comparisonBasis: 'matched-overlap-only',
    });
  });

  it('degrades to an empty envelope when the latency tables are missing', async () => {
    const env = {
      DB: {
        prepare() {
          return {
            bind() {
              return this;
            },
            async all() {
              throw new Error('no such table: disclosure_latency_candidates');
            },
            async first() {
              return null;
            },
            async run() {
              return {};
            },
          };
        },
      },
      CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
    } as never;
    const res = await app.request('http://localhost/latency-summary', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totals: { racedDisclosures: number } };
    expect(body.totals.racedDisclosures).toBe(0);
  });
});
