import { describe, expect, it } from 'vitest';
import { buildAdminRouter } from '../routes';

const app = buildAdminRouter();

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
                  doc_id: 'H-2026-20012345',
                  provider: 'fmp',
                  chamber: 'house',
                  source_url: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20012345.pdf',
                  filed_date: '2026-06-29',
                  filer_name: 'Jane Smith',
                  congress_first_seen_at: '2026-06-29T14:00:00.000Z',
                  provider_key: '20012345',
                  provider_first_seen_at: '2026-06-29T14:03:30.000Z',
                  provider_published_at: '2026-06-29T14:02:00.000Z',
                  match_method: 'doc-token',
                  status: 'matched',
                  attempts: 2,
                  last_checked_at: '2026-06-29T14:03:30.000Z',
                  error: null,
                  created_at: '2026-06-29T14:00:00.000Z',
                  updated_at: '2026-06-29T14:03:30.000Z',
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

describe('admin disclosure latency API', () => {
  it('lists Congress.Trade-vs-FMP observations with computed provider delta', async () => {
    const res = await app.request(
      '/disclosure-latency',
      { headers: { Authorization: 'Bearer admin-secret' } },
      { ADMIN_TOKEN: 'admin-secret', DB: fakeDb() } as never,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ docId: string; providerDeltaSec: number; providerPublishedDeltaSec: number; status: string }>;
    };
    expect(body.items).toEqual([
      expect.objectContaining({
        docId: 'H-2026-20012345',
        providerDeltaSec: 210,
        providerPublishedDeltaSec: 120,
        status: 'matched',
      }),
    ]);
  });

  it('returns aggregate metrics and a public-safe summary payload', async () => {
    const res = await app.request(
      '/disclosure-latency/summary',
      { headers: { Authorization: 'Bearer admin-secret' } },
      { ADMIN_TOKEN: 'admin-secret', FMP_API_KEY: 'configured', DB: fakeDb() } as never,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totals: { candidates: number; matched: number; configuredComparableProviders: number };
      providers: Array<{ provider: string; avgMonitorDeltaSec: number | null; avgProviderPublishedDeltaSec: number | null }>;
      publicSummary: { providers: Array<{ provider: string }> };
    };
    expect(body.totals).toEqual(expect.objectContaining({ candidates: 1, matched: 1, configuredComparableProviders: 1 }));
    expect(body.providers[0]).toEqual(
      expect.objectContaining({ provider: 'fmp', avgMonitorDeltaSec: 210, avgProviderPublishedDeltaSec: 120 }),
    );
    expect(JSON.stringify(body.publicSummary)).not.toContain('H-2026-20012345');
  });
});
