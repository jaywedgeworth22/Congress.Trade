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
                },
                {
                  provider: 'fmp',
                  status: 'matched',
                  congress_first_seen_at: '2026-06-29T10:00:00.000Z',
                  provider_first_seen_at: '2026-06-29T10:30:00.000Z',
                  provider_published_at: null,
                },
                {
                  provider: 'unusual_whales',
                  status: 'pending',
                  congress_first_seen_at: '2026-06-29T14:00:00.000Z',
                  provider_first_seen_at: null,
                  provider_published_at: null,
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
