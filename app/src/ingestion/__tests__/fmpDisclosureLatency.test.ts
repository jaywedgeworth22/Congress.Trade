import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  matchDisclosureCandidate,
  matchFmpDisclosureCandidate,
  parseFmpDisclosureRows,
  parseQuiverDisclosureRows,
  parseUnusualWhalesDisclosureRows,
  recordDisclosureLatencyCandidate,
  runDisclosureLatencyProbe,
} from '../fmpDisclosureLatency';
import type { DiscoveredFiling } from '../watcher';
import type { Env } from '../../shared/types';
import { getDailyUsed } from '../../enrichment/service';
import { __resetSharedFmpPacerForTests } from '../../shared/pace';

describe('parseFmpDisclosureRows', () => {
  it('extracts a House doc token from PTR PDF URLs', () => {
    const rows = parseFmpDisclosureRows('house', [
      {
        representative: 'Jane Smith',
        disclosureDate: '2026-06-29',
        link: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20012345.pdf',
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].providerKey).toBe('20012345');
    expect(rows[0].sourceUrl).toContain('20012345.pdf');
    expect(rows[0].filedDate).toBe('2026-06-29');
  });

  it('accepts wrapped FMP result arrays', () => {
    const rows = parseFmpDisclosureRows('senate', {
      data: [
        {
          senator: 'Smith, Jane',
          filingDate: '06/29/2026',
          url: 'https://efdsearch.senate.gov/search/view/ptr/abcd1234/',
        },
      ],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].providerKey).toBe('abcd1234');
    expect(rows[0].filedDate).toBe('2026-06-29');
  });
});

describe('matchFmpDisclosureCandidate', () => {
  it('matches by canonical House document token', () => {
    const row = parseFmpDisclosureRows('house', [
      { link: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20012345.pdf' },
    ])[0];

    expect(
      matchFmpDisclosureCandidate(
        {
          doc_id: 'H-2026-20012345',
          source_url: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20012345.pdf',
          filed_date: '2026-06-29',
          filer_name: 'Jane Smith',
        },
        row,
      ),
    ).toEqual({ providerKey: '20012345', matchMethod: 'doc-token' });
  });

  it('matches by Senate report id token', () => {
    const row = parseFmpDisclosureRows('senate', [
      { url: 'https://efdsearch.senate.gov/search/view/ptr/abcd1234/' },
    ])[0];

    expect(
      matchFmpDisclosureCandidate(
        {
          doc_id: 'S-abcd1234',
          source_url: 'https://efdsearch.senate.gov/search/view/ptr/abcd1234/',
          filed_date: '2026-06-29',
          filer_name: 'Smith, Jane',
        },
        row,
      ),
    ).toEqual({ providerKey: 'abcd1234', matchMethod: 'doc-token' });
  });

  it('falls back to probable filer/date when no document token is exposed', () => {
    const row = parseFmpDisclosureRows('senate', [
      { senator: 'Smith, Jane', filingDate: '06/29/2026', ticker: 'AAPL' },
    ])[0];

    expect(
      matchFmpDisclosureCandidate(
        {
          doc_id: 'S-hidden-report',
          source_url: null,
          filed_date: '2026-06-29',
          filer_name: 'Smith, Jane',
        },
        row,
      ),
    ).toEqual({ providerKey: row.providerKey, matchMethod: 'filer-date' });
  });
});

describe('parse third-party disclosure providers', () => {
  it('normalizes Unusual Whales recent Congress rows', () => {
    const rows = parseUnusualWhalesDisclosureRows({
      data: [
        {
          filed_at_date: '2026-06-29',
          member_type: 'senate',
          name: 'Jane Smith',
          politician_id: 'abc',
          ticker: 'MSFT',
          transaction_date: '2026-06-20',
          txn_type: 'Buy',
        },
      ],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        provider: 'unusual_whales',
        chamber: 'senate',
        filedDate: '2026-06-29',
        filerName: 'Jane Smith',
        providerPublishedAt: null,
      }),
    );
    expect(
      matchDisclosureCandidate(
        { doc_id: 'S-hidden', source_url: null, filed_date: '2026-06-29', filer_name: 'Smith, Jane' },
        rows[0],
      ),
    ).toEqual({ providerKey: rows[0].providerKey, matchMethod: 'filer-date' });
  });

  it('captures Quiver upload timestamps separately from monitor observation time', () => {
    const rows = parseQuiverDisclosureRows('house', [
      {
        Representative: 'Jane Smith',
        ReportDate: '2026-06-29T00:00:00Z',
        Date: '2026-06-20T00:00:00Z',
        Ticker: 'MSFT',
        Transaction: 'Purchase',
        Quiver_Upload_Time: '2026-06-29T14:05:00Z',
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        provider: 'quiver',
        chamber: 'house',
        filedDate: '2026-06-29',
        filerName: 'Jane Smith',
        providerPublishedAt: '2026-06-29T14:05:00.000Z',
      }),
    );
  });
});

// A KV backed by a Map is enough for the shared 'fmp:calls:<date>' counter
// (getDailyUsed/addDailyUsed) and the probe's last-poll stamp (setLastPollAt).
function fakeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(k: string) {
      return store.get(k) ?? null;
    },
    async put(k: string, v: string) {
      store.set(k, v);
    },
    async delete(k: string) {
      store.delete(k);
    },
  };
}

// Minimal D1: every SELECT yields no rows, every write "succeeds" — enough for
// the probe's observation upserts and pending-candidate match pass to run.
function fakeDb() {
  const stmt = {
    bind() {
      return stmt;
    },
    async all<T>() {
      return { results: [] as T[] };
    },
    async first<T>() {
      return null as T | null;
    },
    async run() {
      return { success: true, meta: { changes: 0 } };
    },
  };
  return {
    prepare() {
      return stmt;
    },
    async batch() {
      return [];
    },
  } as unknown as D1Database;
}

const dayCounterKey = () => 'fmp:calls:' + new Date().toISOString().slice(0, 10);

describe('recordDisclosureLatencyCandidate chamber guard', () => {
  function trackingEnv() {
    const prepared: string[] = [];
    const stmt = {
      bind() { return stmt; },
      async run() { return { success: true, meta: { changes: 1 } }; },
      async all<T>() { return { results: [] as T[] }; },
      async first<T>() { return null as T | null; },
    };
    const env = {
      DB: { prepare(sql: string) { prepared.push(sql); return stmt; } },
    } as unknown as Env;
    return { env, prepared };
  }

  const filing = (chamber: DiscoveredFiling['chamber']): DiscoveredFiling => ({
    docId: `${chamber}-1`,
    chamber,
    sourceUrl: 'https://example.test/x.pdf',
    filedDate: '2026-06-01',
    filerName: 'Someone',
  });

  it('writes candidate rows for house filings', async () => {
    const { env, prepared } = trackingEnv();
    await recordDisclosureLatencyCandidate(env, filing('house'), '2026-06-02T00:00:00Z');
    expect(prepared.some((s) => /INSERT INTO disclosure_latency_candidates/i.test(s))).toBe(true);
  });

  it('skips executive filings entirely (would otherwise sit permanently pending)', async () => {
    const { env, prepared } = trackingEnv();
    await recordDisclosureLatencyCandidate(env, filing('executive'), '2026-06-02T00:00:00Z');
    expect(prepared.some((s) => /disclosure_latency_candidates/i.test(s))).toBe(false);
  });
});

describe('runDisclosureLatencyProbe FMP budget accounting', () => {
  beforeEach(() => __resetSharedFmpPacerForTests());

  it('increments the SAME daily FMP counter enrichment uses (2 calls: house + senate)', async () => {
    const kv = fakeKv();
    const env = {
      FMP_API_KEY: 'test-key',
      FMP_DAILY_CALL_CAP: '1000',
      CONFIG_KV: kv,
      DB: fakeDb(),
    } as unknown as Parameters<typeof runDisclosureLatencyProbe>[0];

    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => [] }) as unknown as Response);

    expect(await getDailyUsed(env)).toBe(0);
    const result = await runDisclosureLatencyProbe(env, new Date(), fetchImpl, {
      force: true,
      providers: ['fmp'],
    });

    // Two FMP HTTP requests fired (house-latest + senate-latest)...
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // ...and both were billed to the shared enrichment counter.
    expect(await getDailyUsed(env)).toBe(2);
    expect(kv.store.get(dayCounterKey())).toBe('2');
    expect(result.errors).toEqual([]);
  });

  it('reserves room for the full house+senate batch (skips at cap-1, no overshoot)', async () => {
    const kv = fakeKv({ [dayCounterKey()]: '999' });
    const env = {
      FMP_API_KEY: 'test-key',
      FMP_DAILY_CALL_CAP: '1000',
      CONFIG_KV: kv,
      DB: fakeDb(),
    } as unknown as Parameters<typeof runDisclosureLatencyProbe>[0];

    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => [] }) as unknown as Response);

    const result = await runDisclosureLatencyProbe(env, new Date(), fetchImpl, {
      force: true,
      providers: ['fmp'],
    });

    // Firing both calls would land the counter at 1001; the batch is skipped so
    // it never exceeds the cap and the counter stays untouched.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await getDailyUsed(env)).toBe(999);
    expect(result.errors.some((e) => /FMP_DAILY_CALL_CAP reached/.test(e))).toBe(true);
  });

  it('skips the FMP fetch (and spends nothing) once the daily cap is exhausted', async () => {
    const kv = fakeKv({ [dayCounterKey()]: '1000' });
    const env = {
      FMP_API_KEY: 'test-key',
      FMP_DAILY_CALL_CAP: '1000',
      CONFIG_KV: kv,
      DB: fakeDb(),
    } as unknown as Parameters<typeof runDisclosureLatencyProbe>[0];

    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => [] }) as unknown as Response);

    const result = await runDisclosureLatencyProbe(env, new Date(), fetchImpl, {
      force: true,
      providers: ['fmp'],
    });

    // No FMP request fired and the counter is untouched.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await getDailyUsed(env)).toBe(1000);
    expect(result.errors.some((e) => /FMP_DAILY_CALL_CAP reached/.test(e))).toBe(true);
  });
});

// Same Infisical login/secrets stubbing pattern as
// src/export/__tests__/routes.test.ts: Infisical uses the global `fetch`
// (not the `fetchImpl` injected into runDisclosureLatencyProbe), so stubbing
// globalThis.fetch is what lets resolveSecret see Infisical-sourced values.
function stubInfisical(secrets: Record<string, string>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('/api/v1/auth/universal-auth/login')) {
        return Response.json({ accessToken: 'infisical-token' });
      }
      if (url.includes('/api/v3/secrets/raw')) {
        return Response.json({
          secrets: Object.entries(secrets).map(([secretKey, secretValue]) => ({ secretKey, secretValue })),
        });
      }
      return new Response('not found', { status: 404 });
    }),
  );
}

describe('runDisclosureLatencyProbe DISCLOSURE_LATENCY_WATCH_ENABLED via resolveSecret', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('gates open from Infisical alone, with no raw env var set (proves the gate reads through resolveSecret)', async () => {
    stubInfisical({ DISCLOSURE_LATENCY_WATCH_ENABLED: 'true' });

    const env = {
      // DISCLOSURE_LATENCY_WATCH_ENABLED / FMP_DISCLOSURE_WATCH_ENABLED
      // deliberately absent — only Infisical says "true".
      CONFIG_KV: fakeKv(),
      DB: fakeDb(),
      INFISICAL_BASE_URL: 'https://infisical.test',
      INFISICAL_ENV: 'prod',
      INFISICAL_APP_PROJECT_ID: 'disclosure-watch-enabled-test',
      INFISICAL_APP_CLIENT_ID: 'app-client',
      INFISICAL_APP_CLIENT_SECRET: 'app-secret',
    } as unknown as Parameters<typeof runDisclosureLatencyProbe>[0];

    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => [] }) as unknown as Response);
    const result = await runDisclosureLatencyProbe(env, new Date(), fetchImpl, { providers: ['fmp'] });

    expect(result.enabled).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('lets an Infisical value override a conflicting raw env value (Infisical wins, not the raw env)', async () => {
    stubInfisical({ DISCLOSURE_LATENCY_WATCH_ENABLED: 'false' });

    const env = {
      DISCLOSURE_LATENCY_WATCH_ENABLED: 'true', // wrangler.toml-style value says on...
      CONFIG_KV: fakeKv(),
      DB: fakeDb(),
      INFISICAL_BASE_URL: 'https://infisical.test',
      INFISICAL_ENV: 'prod',
      INFISICAL_APP_PROJECT_ID: 'disclosure-watch-override-test',
      INFISICAL_APP_CLIENT_ID: 'app-client',
      INFISICAL_APP_CLIENT_SECRET: 'app-secret',
    } as unknown as Parameters<typeof runDisclosureLatencyProbe>[0];

    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => [] }) as unknown as Response);
    const result = await runDisclosureLatencyProbe(env, new Date(), fetchImpl, { providers: ['fmp'] });

    // ...but Infisical says off, and Infisical wins.
    expect(result.enabled).toBe(false);
    expect(result.reason).toBe('DISCLOSURE_LATENCY_WATCH_ENABLED is not true');
  });

  it('invariant: with zero Infisical sources configured, an env-true value behaves exactly as before', async () => {
    // No INFISICAL_* vars at all -> resolverEnabled() is false -> resolveSecret
    // resolves straight to {source:'missing'} without any network call, and the
    // `?? env.DISCLOSURE_LATENCY_WATCH_ENABLED` fallback carries the
    // wrangler.toml-sourced value through unchanged.
    const env = {
      DISCLOSURE_LATENCY_WATCH_ENABLED: 'true',
      CONFIG_KV: fakeKv(),
      DB: fakeDb(),
    } as unknown as Parameters<typeof runDisclosureLatencyProbe>[0];

    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => [] }) as unknown as Response);
    const result = await runDisclosureLatencyProbe(env, new Date(), fetchImpl, { providers: ['fmp'] });

    expect(result.enabled).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('invariant: with zero Infisical sources configured, an env-false value stays disabled exactly as before', async () => {
    const env = {
      DISCLOSURE_LATENCY_WATCH_ENABLED: 'false',
      CONFIG_KV: fakeKv(),
      DB: fakeDb(),
    } as unknown as Parameters<typeof runDisclosureLatencyProbe>[0];

    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => [] }) as unknown as Response);
    const result = await runDisclosureLatencyProbe(env, new Date(), fetchImpl, { providers: ['fmp'] });

    expect(result.enabled).toBe(false);
    expect(result.reason).toBe('DISCLOSURE_LATENCY_WATCH_ENABLED is not true');
  });
});
