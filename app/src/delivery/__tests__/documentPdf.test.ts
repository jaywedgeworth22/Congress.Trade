import { describe, expect, it } from 'vitest';
import {
  buildRestRouter,
  documentPdfGateWantsJson,
  documentPdfUpgradePayload,
} from '../rest.ts';
import type { Env } from '../../shared/types.ts';

describe('documentPdfGateWantsJson', () => {
  it('is true for Bearer and for Accept: application/pdf', () => {
    expect(documentPdfGateWantsJson({ authorization: 'Bearer abc' })).toBe(true);
    expect(documentPdfGateWantsJson({ accept: 'application/pdf' })).toBe(true);
    expect(documentPdfGateWantsJson({
      authorization: 'Bearer abc',
      accept: 'application/pdf',
    })).toBe(true);
  });

  it('is false for a browser HTML navigation without Bearer', () => {
    expect(documentPdfGateWantsJson({
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    })).toBe(false);
    expect(documentPdfGateWantsJson({})).toBe(false);
  });
});

function pdfEnv(opts: { plan?: 'premium' | 'free'; stored?: boolean } = {}): Env {
  const stored = opts.stored !== false;
  return {
    CONFIG_KV: {
      get: async (key: string) => {
        if (key === 'sess:free-token') return JSON.stringify({ userId: 'user_free' });
        if (key === 'sess:premium-token') return JSON.stringify({ userId: 'user_premium' });
        return null;
      },
      put: async () => {},
      delete: async () => {},
    },
    DB: {
      prepare: (sql: string) => ({
        params: [] as unknown[],
        bind(...params: unknown[]) {
          this.params = params;
          return this;
        },
        async first() {
          if (/FROM filings WHERE doc_id/i.test(sql)) {
            if (!stored) return null;
            return {
              raw_object_key: 'raw/doc.pdf',
              source_url: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20034784.pdf',
            };
          }
          if (/SELECT \* FROM users WHERE id = \?/i.test(sql)) {
            const id = String(this.params[0] ?? '');
            const isPremium = id === 'user_premium' || opts.plan === 'premium';
            const isFree = id === 'user_free' || opts.plan === 'free';
            if (!isPremium && !isFree) return null;
            return {
              id,
              email: `${id}@example.com`,
              name: 'User',
              picture: null,
              google_sub: null,
              email_verified: 1,
              created_at: '2026-01-01T00:00:00.000Z',
              last_login_at: null,
              subscription_status: isPremium ? 'active' : 'canceled',
              plan: isPremium ? 'monthly' : null,
            };
          }
          if (/FROM apple_subscriptions/i.test(sql)) return null;
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          return {};
        },
      }),
    },
    RAW_FILES: {
      get: async (key: string) => {
        if (key !== 'raw/doc.pdf') return null;
        return {
          body: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
          httpMetadata: { contentType: 'application/pdf' },
        };
      },
    },
  } as unknown as Env;
}

describe('GET /documents/:docId/pdf (APPSTORECOMPLIANCE-01/02)', () => {
  const upgrade = documentPdfUpgradePayload();

  it('returns 402 JSON for a Bearer free session, not a 302 to /pricing', async () => {
    const app = buildRestRouter();
    const res = await app.request(
      'http://localhost/documents/H-2026-1/pdf',
      { headers: { authorization: 'Bearer free-token' } },
      pdfEnv({ plan: 'free' }),
    );
    expect(res.status).toBe(402);
    expect(res.headers.get('location')).toBeNull();
    const body = (await res.json()) as typeof upgrade;
    expect(body).toEqual(upgrade);
  });

  it('returns 402 JSON when Accept is application/pdf and the user is not premium', async () => {
    const app = buildRestRouter();
    const res = await app.request(
      'http://localhost/documents/H-2026-1/pdf',
      { headers: { accept: 'application/pdf' } },
      pdfEnv(),
    );
    expect(res.status).toBe(402);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.json()).toEqual(upgrade);
  });

  it('still 302s a browser HTML navigation without Bearer to the web paywall', async () => {
    const app = buildRestRouter();
    const res = await app.request(
      'http://localhost/documents/H-2026-1/pdf',
      { headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } },
      pdfEnv(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location') ?? '').toMatch(/\/pricing\?feature=pdf/);
  });

  it('serves the stored PDF for Premium and never redirects to the government source', async () => {
    const app = buildRestRouter();
    const res = await app.request(
      'http://localhost/documents/H-2026-1/pdf',
      { headers: { authorization: 'Bearer premium-token', accept: 'application/pdf' } },
      pdfEnv({ plan: 'premium' }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/pdf');
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('x-congress-trade-source')).toBe('stored-raw');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes)).toEqual([0x25, 0x50, 0x44, 0x46]);
  });

  it('does not leak the public government URL as a redirect when storage is empty', async () => {
    const app = buildRestRouter();
    const res = await app.request(
      'http://localhost/documents/H-2026-1/pdf',
      { headers: { authorization: 'Bearer premium-token', accept: 'application/pdf' } },
      pdfEnv({ plan: 'premium', stored: false }),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get('location')).toBeNull();
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/not fetched|not found/i);
  });
});
