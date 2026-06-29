import { describe, it, expect } from 'vitest';
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
          if (/FROM ingest_log/i.test(sql)) {
            return {
              results: [
                {
                  source: 'house',
                  last_used_at: '2026-06-24T12:00:00.000Z',
                  calls_total: 10,
                  calls_last_24h: 4,
                  calls_today: 2,
                },
              ] as T[],
            };
          }
          if (/FROM securities_ref/i.test(sql) && /CASE\s+WHEN lower\(source\)/i.test(sql)) {
            return {
              results: [
                {
                  provider: 'massive',
                  calls_total: 2,
                  calls_last_24h: 1,
                  calls_today: 1,
                  last_used_at: '2026-06-24T11:30:00.000Z',
                  errors_last_24h: 0,
                },
              ] as T[],
            };
          }
          if (/FROM securities_ref/i.test(sql) && /COUNT\(\*\) AS calls_total/i.test(sql)) {
            return {
              results: [
                {
                  calls_total: 5,
                  calls_last_24h: 2,
                  calls_today: 1,
                  last_used_at: '2026-06-24T11:00:00.000Z',
                  errors_last_24h: 1,
                },
              ] as T[],
            };
          }
          if (/FROM securities_ref/i.test(sql) && /enrichment_error/i.test(sql)) {
            return {
              results: [
                {
                  enriched_at: '2026-06-24T11:00:00.000Z',
                  ticker: 'AAPL',
                  enrichment_error: 'FMP_HTTP_429 rate limited',
                },
              ] as T[],
            };
          }
          if (/FROM price_eod/i.test(sql)) {
            return {
              results: [
                {
                  calls_total: 7,
                  calls_last_24h: 20,
                  calls_today: 3,
                  last_used_at: '2026-06-24',
                },
              ] as T[],
            };
          }
          if (/FROM spx_eod/i.test(sql)) {
            return {
              results: [
                {
                  calls_total: 100,
                  calls_last_24h: 1,
                  calls_today: 1,
                  last_used_at: '2026-06-24',
                },
              ] as T[],
            };
          }
          if (/FROM tx_performance/i.test(sql)) {
            return {
              results: [
                {
                  calls_total: 50,
                  calls_last_24h: 10,
                  calls_today: 5,
                  last_used_at: '2026-06-24T12:30:00.000Z',
                },
              ] as T[],
            };
          }
          if (/FROM deliveries/i.test(sql)) return { results: [] as T[] };
          if (/FROM review_queue/i.test(sql)) return { results: [] as T[] };
          if (/FROM client_commands/i.test(sql)) return { results: [] as T[] };
          return { results: [] as T[] };
        },
        async first<T>() {
          if (/FROM filings/i.test(sql) && /COUNT\(\*\)/i.test(sql)) {
            return {
              calls_total: 3,
              calls_last_24h: 1,
              calls_today: 1,
              last_used_at: '2026-06-24T10:00:00.000Z',
              errors_last_24h: 1,
            } as T;
          }
          return null as T | null;
        },
        async run() {
          return { success: true, meta: { changes: 1 } };
        },
        sql,
      };
    },
  } as unknown as D1Database;
}

describe('admin diagnostics API', () => {
  it('reports connection status and recent app errors without exposing secret values', async () => {
    const res = await app.request(
      '/diagnostics',
      { headers: { Authorization: 'Bearer admin-secret' } },
      {
        ADMIN_TOKEN: 'admin-secret',
        GEMINI_API_KEY: 'gemini-secret',
        FMP_API_KEY: 'fmp-secret',
        MASSIVE_API_KEY: 'massive-secret',
        PRICE_PROVIDER: 'massive',
        DB: fakeDb(),
      } as never,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connections: Array<{ id: string; status: string; configured: boolean; callsToday: number }>;
      errors: Array<{ area: string; subject: string; message: string }>;
    };

    expect(body.connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'provider:gemini',
          status: 'error',
          configured: true,
          callsToday: 1,
        }),
        expect.objectContaining({ id: 'source:house', status: 'ok', callsToday: 2 }),
        expect.objectContaining({ id: 'provider:massive', status: 'ok', configured: true, callsToday: 1 }),
        expect.objectContaining({ id: 'cache:prices', status: 'ok', configured: true, callsToday: 3 }),
        expect.objectContaining({ id: 'cache:spx', status: 'ok', configured: true, callsToday: 1 }),
        expect.objectContaining({ id: 'cache:performance', status: 'ok', configured: true, callsToday: 5 }),
      ]),
    );
    expect(JSON.stringify(body)).not.toContain('gemini-secret');
    expect(JSON.stringify(body)).not.toContain('fmp-secret');
    expect(JSON.stringify(body)).not.toContain('massive-secret');
    expect(body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          area: 'Enrichment',
          subject: 'AAPL',
          message: 'FMP_HTTP_429 rate limited',
        }),
      ]),
    );
  });
});
