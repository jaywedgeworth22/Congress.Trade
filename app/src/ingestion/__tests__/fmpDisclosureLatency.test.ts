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

// A minimal stateful D1 covering exactly the SQL shapes this probe issues
// against disclosure_latency_candidates / disclosure_provider_observations,
// so the deep-match pass's DB reads/writes (pending-candidate lookups,
// match/no-match updates, provider-observation upserts) actually take
// effect instead of the always-empty fakeDb() above. Statements are
// dispatched by matching stable substrings of the known query templates
// (see matchAndUpdateCandidates / matchPendingCandidates /
// runUnusualWhalesDeepMatch / upsertProviderRows / loadProviderRows in
// ../fmpDisclosureLatency.ts) rather than parsing SQL.
interface SeedCandidate {
  doc_id: string;
  provider?: string;
  chamber?: string;
  source_url?: string | null;
  filed_date?: string | null;
  filer_name?: string | null;
  congress_first_seen_at?: string;
  status?: string;
  attempts?: number;
  created_at?: string;
}

interface CandidateState {
  doc_id: string;
  provider: string;
  chamber: string;
  source_url: string | null;
  filed_date: string | null;
  filer_name: string | null;
  congress_first_seen_at: string;
  status: string;
  attempts: number;
  provider_key: string | null;
  provider_first_seen_at: string | null;
  provider_published_at: string | null;
  match_method: string | null;
  payload: string | null;
  last_checked_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function fakeLatencyDb(seed: SeedCandidate[] = []) {
  const candidates = new Map<string, CandidateState>();
  for (const s of seed) {
    const createdAt = s.created_at ?? s.congress_first_seen_at ?? '2026-01-01T00:00:00.000Z';
    candidates.set(`${s.doc_id}::${s.provider ?? 'unusual_whales'}`, {
      doc_id: s.doc_id,
      provider: s.provider ?? 'unusual_whales',
      chamber: s.chamber ?? 'house',
      source_url: s.source_url ?? null,
      filed_date: s.filed_date ?? null,
      filer_name: s.filer_name ?? null,
      congress_first_seen_at: s.congress_first_seen_at ?? '2026-01-01T00:00:00.000Z',
      status: s.status ?? 'pending',
      attempts: s.attempts ?? 0,
      provider_key: null,
      provider_first_seen_at: null,
      provider_published_at: null,
      match_method: null,
      payload: null,
      last_checked_at: null,
      error: null,
      created_at: createdAt,
      updated_at: createdAt,
    });
  }
  const observations = new Map<string, Record<string, unknown>>();

  function candidateRow(c: CandidateState) {
    return {
      doc_id: c.doc_id,
      provider: c.provider,
      chamber: c.chamber,
      source_url: c.source_url,
      filed_date: c.filed_date,
      filer_name: c.filer_name,
      congress_first_seen_at: c.congress_first_seen_at,
      attempts: c.attempts,
    };
  }

  function select(sql: string, params: unknown[]): Record<string, unknown>[] {
    if (sql.includes('FROM disclosure_latency_candidates') && sql.includes('filed_date < ?')) {
      const [provider, beforeDate, cap] = params as [string, string, number];
      return Array.from(candidates.values())
        .filter(
          (c) => c.provider === provider && c.status === 'pending' && c.filed_date != null && c.filed_date < beforeDate,
        )
        .sort((a, b) => ((a.filed_date ?? '') < (b.filed_date ?? '') ? -1 : (a.filed_date ?? '') > (b.filed_date ?? '') ? 1 : 0))
        .slice(0, cap)
        .map(candidateRow);
    }
    if (sql.includes('FROM disclosure_latency_candidates')) {
      const [provider] = params as [string];
      return Array.from(candidates.values())
        .filter((c) => c.provider === provider && c.status === 'pending')
        .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
        .slice(0, 100)
        .map(candidateRow);
    }
    if (sql.includes('FROM disclosure_provider_observations')) {
      const [provider, cutoff] = params as [string, string];
      return Array.from(observations.values())
        .filter((o) => o.provider === provider && (o.first_observed_at as string) >= cutoff)
        .sort((a, b) => ((a.first_observed_at as string) < (b.first_observed_at as string) ? 1 : -1))
        .slice(0, 1000);
    }
    return [];
  }

  function write(sql: string, params: unknown[]): void {
    if (sql.includes('UPDATE disclosure_latency_candidates') && sql.includes("status = 'matched'")) {
      const [providerKey, providerFirstSeenAt, providerPublishedAt, matchMethod, payload, lastCheckedAt, updatedAt, docId, provider] =
        params as (string | null)[];
      const row = candidates.get(`${docId}::${provider}`);
      if (!row) return;
      row.status = 'matched';
      row.provider_key = providerKey;
      row.provider_first_seen_at = providerFirstSeenAt;
      row.provider_published_at = providerPublishedAt;
      row.match_method = matchMethod;
      row.payload = payload;
      row.attempts += 1;
      row.last_checked_at = lastCheckedAt;
      row.error = null;
      row.updated_at = updatedAt ?? row.updated_at;
      return;
    }
    if (sql.includes('UPDATE disclosure_latency_candidates')) {
      const [lastCheckedAt, updatedAt, error, docId, provider] = params as (string | null)[];
      const row = candidates.get(`${docId}::${provider}`);
      if (!row) return;
      row.attempts += 1;
      row.last_checked_at = lastCheckedAt;
      row.updated_at = updatedAt ?? row.updated_at;
      row.error = error;
      return;
    }
    if (sql.includes('INSERT INTO disclosure_provider_observations')) {
      const [provider, chamber, providerKey, firstObservedAt, lastObservedAt, providerPublishedAt, sourceUrl, filedDate, filerName, payload] =
        params as (string | null)[];
      const key = `${provider}::${chamber}::${providerKey}`;
      const existing = observations.get(key);
      if (existing) {
        existing.last_observed_at = lastObservedAt;
        existing.provider_published_at = existing.provider_published_at ?? providerPublishedAt;
        existing.source_url = existing.source_url ?? sourceUrl;
        existing.filed_date = existing.filed_date ?? filedDate;
        existing.filer_name = existing.filer_name ?? filerName;
        existing.payload = existing.payload ?? payload;
      } else {
        observations.set(key, {
          provider,
          chamber,
          provider_key: providerKey,
          first_observed_at: firstObservedAt,
          last_observed_at: lastObservedAt,
          provider_published_at: providerPublishedAt,
          source_url: sourceUrl,
          filed_date: filedDate,
          filer_name: filerName,
          payload,
        });
      }
    }
  }

  function makeStmt(sqlRaw: string) {
    const sql = sqlRaw.replace(/\s+/g, ' ').trim();
    let params: unknown[] = [];
    const stmt = {
      bind(...args: unknown[]) {
        params = args;
        return stmt;
      },
      async all<T>() {
        return { results: select(sql, params) as T[] };
      },
      async first<T>() {
        const rows = select(sql, params);
        return (rows[0] ?? null) as T | null;
      },
      async run() {
        write(sql, params);
        return { success: true, meta: { changes: 1 } };
      },
    };
    return stmt;
  }

  // No `batch` method on purpose: shared/db.ts's batch() helper falls back
  // to running each bound statement's .run() sequentially when the D1
  // binding lacks one, which is exactly the semantics this fake needs.
  return {
    prepare(sql: string) {
      return makeStmt(sql);
    },
    candidates,
    observations,
  } as unknown as D1Database & {
    candidates: Map<string, CandidateState>;
    observations: Map<string, Record<string, unknown>>;
  };
}

function uwRecentTradesFetch(byDate: Record<string, unknown[]>, freshPage: unknown[]) {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    const dateMatch = /[?&]date=([^&]+)/.exec(url);
    if (dateMatch) {
      const date = decodeURIComponent(dateMatch[1]);
      if (date in byDate) {
        return { ok: true, json: async () => ({ data: byDate[date] }) } as unknown as Response;
      }
      return { ok: false, status: 401, json: async () => ({}) } as unknown as Response;
    }
    return { ok: true, json: async () => ({ data: freshPage }) } as unknown as Response;
  });
}

describe('unusual_whales deep match (stranded pending observations)', () => {
  it('fetches a date-anchored deep-match page for a pending observation outside the normal window, and matches it', async () => {
    const db = fakeLatencyDb([
      {
        doc_id: 'H-old-1',
        filed_date: '2026-01-05',
        filer_name: 'Jane Smith',
        congress_first_seen_at: '2026-01-05T12:00:00.000Z',
        created_at: '2026-01-05T12:00:00.000Z',
      },
    ]);
    const env = {
      UNUSUAL_WHALES_API_KEY: 'test-key',
      CONFIG_KV: fakeKv(),
      DB: db,
    } as unknown as Parameters<typeof runDisclosureLatencyProbe>[0];

    const freshPage = [
      { filed_at_date: '2026-01-10', member_type: 'house', name: 'John Doe', politician_id: 'a', ticker: 'MSFT', transaction_date: '2026-01-08', txn_type: 'Sell' },
    ];
    const fetchImpl = uwRecentTradesFetch(
      {
        '2026-01-05': [
          { filed_at_date: '2026-01-05', member_type: 'house', name: 'Jane Smith', politician_id: 'b', ticker: 'AAPL', transaction_date: '2026-01-01', txn_type: 'Buy' },
        ],
      },
      freshPage,
    );

    const result = await runDisclosureLatencyProbe(env, new Date('2026-01-10T15:00:00.000Z'), fetchImpl, {
      force: true,
      providers: ['unusual_whales'],
    });

    // One normal recent-trades call plus exactly one deep-match call, for
    // the single distinct filed_date among the provably-outside-window
    // pending candidates.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const deepCallUrl = fetchImpl.mock.calls.map(([u]) => String(u)).find((u) => u.includes('date='));
    expect(deepCallUrl).toContain('date=2026-01-05');
    expect(deepCallUrl).toContain('limit=200');

    expect(db.candidates.get('H-old-1::unusual_whales')?.status).toBe('matched');
    expect(result.matched).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it('caps deep-match fetches to the configured number of distinct dates, oldest pending first', async () => {
    const seed: SeedCandidate[] = [];
    for (let day = 1; day <= 10; day++) {
      const date = `2026-01-${String(day).padStart(2, '0')}`;
      seed.push({
        doc_id: `H-old-${day}`,
        filed_date: date,
        filer_name: 'Nobody Matches',
        congress_first_seen_at: `${date}T12:00:00.000Z`,
        created_at: `${date}T12:00:00.000Z`,
      });
    }
    const db = fakeLatencyDb(seed);
    const env = {
      UNUSUAL_WHALES_API_KEY: 'test-key',
      CONFIG_KV: fakeKv(),
      DB: db,
      // UW_DEEP_MATCH_DATES_PER_RUN left unset -> default cap of 8.
    } as unknown as Parameters<typeof runDisclosureLatencyProbe>[0];

    const freshPage = [
      { filed_at_date: '2026-01-15', member_type: 'house', name: 'John Doe', politician_id: 'z', ticker: 'MSFT', transaction_date: '2026-01-14', txn_type: 'Sell' },
    ];
    // No deep-match page returns a real match; this test only cares which
    // dates get fetched, not match outcomes.
    const fetchImpl = uwRecentTradesFetch(
      Object.fromEntries(seed.map((s) => [s.filed_date as string, []])),
      freshPage,
    );

    await runDisclosureLatencyProbe(env, new Date('2026-01-15T12:00:00.000Z'), fetchImpl, {
      force: true,
      providers: ['unusual_whales'],
    });

    const deepDates = fetchImpl.mock.calls
      .map(([u]) => String(u))
      .map((u) => /[?&]date=([^&]+)/.exec(u)?.[1])
      .filter((d): d is string => !!d)
      .sort();
    expect(deepDates).toHaveLength(8);
    expect(deepDates).toEqual([
      '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04',
      '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08',
    ]);

    // The two oldest-but-uncapped dates (09, 10) were never targeted: their
    // candidates only saw the one normal-pass attempt, not a second
    // deep-match attempt.
    expect(db.candidates.get('H-old-9::unusual_whales')?.attempts).toBe(1);
    expect(db.candidates.get('H-old-10::unusual_whales')?.attempts).toBe(1);
    expect(db.candidates.get('H-old-9::unusual_whales')?.status).toBe('pending');
    // The 8 capped dates were checked twice this run (normal pass + deep
    // pass), same attempt/backoff bookkeeping the normal pass already uses.
    expect(db.candidates.get('H-old-1::unusual_whales')?.attempts).toBe(2);
    expect(db.candidates.get('H-old-8::unusual_whales')?.attempts).toBe(2);
  });

  it('degrades a single deep-match date fetch failure (401) without failing the probe; attempt still recorded, observation stays pending', async () => {
    const db = fakeLatencyDb([
      {
        doc_id: 'H-old-1',
        filed_date: '2026-01-05',
        filer_name: 'Jane Smith',
        congress_first_seen_at: '2026-01-05T12:00:00.000Z',
        created_at: '2026-01-05T12:00:00.000Z',
      },
    ]);
    const env = {
      UNUSUAL_WHALES_API_KEY: 'test-key',
      CONFIG_KV: fakeKv(),
      DB: db,
    } as unknown as Parameters<typeof runDisclosureLatencyProbe>[0];

    const freshPage = [
      { filed_at_date: '2026-01-10', member_type: 'house', name: 'John Doe', politician_id: 'a', ticker: 'MSFT', transaction_date: '2026-01-08', txn_type: 'Sell' },
    ];
    // byDate deliberately omits '2026-01-05' so uwRecentTradesFetch's fallback
    // returns a 401 for the deep-match call (simulates a lapsed trial key).
    const fetchImpl = uwRecentTradesFetch({}, freshPage);

    const result = await runDisclosureLatencyProbe(env, new Date('2026-01-10T15:00:00.000Z'), fetchImpl, {
      force: true,
      providers: ['unusual_whales'],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.enabled).toBe(true);
    const row = db.candidates.get('H-old-1::unusual_whales');
    expect(row?.status).toBe('pending');
    // Attempted twice this run (normal pass + deep pass), same as any other
    // checked-but-unmatched candidate.
    expect(row?.attempts).toBe(2);
    expect(row?.error).toMatch(/HTTP_401/);
    expect(result.errors.some((e) => /unusual_whales:.*HTTP_401/.test(e))).toBe(true);
  });

  it('UW_DEEP_MATCH_DATES_PER_RUN=0 disables the deep-match pass entirely (no extra fetches)', async () => {
    const db = fakeLatencyDb([
      {
        doc_id: 'H-old-1',
        filed_date: '2026-01-05',
        filer_name: 'Jane Smith',
        congress_first_seen_at: '2026-01-05T12:00:00.000Z',
        created_at: '2026-01-05T12:00:00.000Z',
      },
    ]);
    const env = {
      UNUSUAL_WHALES_API_KEY: 'test-key',
      UW_DEEP_MATCH_DATES_PER_RUN: '0',
      CONFIG_KV: fakeKv(),
      DB: db,
    } as unknown as Parameters<typeof runDisclosureLatencyProbe>[0];

    const freshPage = [
      { filed_at_date: '2026-01-10', member_type: 'house', name: 'John Doe', politician_id: 'a', ticker: 'MSFT', transaction_date: '2026-01-08', txn_type: 'Sell' },
    ];
    const fetchImpl = uwRecentTradesFetch(
      { '2026-01-05': [{ filed_at_date: '2026-01-05', member_type: 'house', name: 'Jane Smith', politician_id: 'b' }] },
      freshPage,
    );

    const result = await runDisclosureLatencyProbe(env, new Date('2026-01-10T15:00:00.000Z'), fetchImpl, {
      force: true,
      providers: ['unusual_whales'],
    });

    // Only the normal recent-trades call fired; the knob being 0 means the
    // deep-match pass returns immediately without touching the DB or fetch.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const row = db.candidates.get('H-old-1::unusual_whales');
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(1);
    expect(result.matched).toBe(0);
  });
});
