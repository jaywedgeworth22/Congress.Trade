import { describe, expect, it } from 'vitest';
import { buildClientRouter } from '../routes';
import { createSession } from '../../auth/session';
import type { Env, QueueMessage } from '../../shared/types';
import type { FeedTransactionRow, SubscriptionRow } from '../../delivery/rows';
import type { CommandRow } from '../state';

type PrefRow = {
  user_id: string;
  saved_filters: string;
  watchlist: string;
  notification_settings: string;
  default_window: string | null;
  updated_at: string;
};

function userRow(id = 'user_1') {
  return {
    id,
    email: 'mobile@example.com',
    name: 'Mobile User',
    picture: null,
    google_sub: null,
    email_verified: 1,
    created_at: '2026-06-24T00:00:00.000Z',
    last_login_at: null,
  };
}

function makeEnv() {
  const kv = new Map<string, string>();
  const subscriptions = new Map<string, SubscriptionRow>();
  const commands = new Map<string, CommandRow>();
  const preferences = new Map<string, PrefRow>();
  const feedRows: FeedTransactionRow[] = [];

  const prepare = (sql: string) => ({
    params: [] as unknown[],
    bind(...params: unknown[]) {
      this.params = params;
      return this;
    },
    async first<T>() {
      if (/FROM users WHERE id = \?/i.test(sql) && this.params[0] === 'user_1') {
        return userRow() as T;
      }
      if (/FROM user_preferences WHERE user_id = \?/i.test(sql)) {
        return (preferences.get(String(this.params[0])) ?? null) as T | null;
      }
      if (/FROM client_commands WHERE id = \? AND user_id = \?/i.test(sql)) {
        const row = commands.get(String(this.params[0]));
        return (row && row.user_id === this.params[1] ? row : null) as T | null;
      }
      if (/FROM client_commands WHERE user_id = \? AND idempotency_key = \?/i.test(sql)) {
        const found = Array.from(commands.values()).find(
          (row) => row.user_id === this.params[0] && row.idempotency_key === this.params[1],
        );
        return (found ?? null) as T | null;
      }
      if (/FROM subscriptions WHERE id = \?/i.test(sql)) {
        return (subscriptions.get(String(this.params[0])) ?? null) as T | null;
      }
      if (/COUNT\(\*\) AS total/i.test(sql)) {
        return { total: feedRows.length } as T;
      }
      return null as T | null;
    },
    async all<T>() {
      if (/FROM client_commands WHERE user_id = \?/i.test(sql)) {
        return {
          results: Array.from(commands.values()).filter((row) => row.user_id === this.params[0]) as T[],
        };
      }
      if (/FROM subscriptions WHERE client_id = \?/i.test(sql)) {
        return {
          results: Array.from(subscriptions.values()).filter((row) => row.client_id === this.params[0]) as T[],
        };
      }
      if (/FROM transactions t/i.test(sql)) {
        return { results: feedRows as T[] };
      }
      return { results: [] as T[] };
    },
    async run() {
      if (/INSERT INTO user_preferences/i.test(sql)) {
        const [userId, savedFilters, watchlist, notificationSettings, defaultWindow, updatedAt] = this.params;
        preferences.set(String(userId), {
          user_id: String(userId),
          saved_filters: String(savedFilters),
          watchlist: String(watchlist),
          notification_settings: String(notificationSettings),
          default_window: defaultWindow == null ? null : String(defaultWindow),
          updated_at: String(updatedAt),
        });
      } else if (/INSERT INTO client_commands/i.test(sql)) {
        const [id, userId, type, status, idempotencyKey, payload, createdAt, updatedAt] = this.params;
        commands.set(String(id), {
          id: String(id),
          user_id: String(userId),
          type: String(type),
          status: String(status),
          idempotency_key: idempotencyKey == null ? null : String(idempotencyKey),
          payload: String(payload),
          result: null,
          error: null,
          created_at: String(createdAt),
          updated_at: String(updatedAt),
          started_at: null,
          finished_at: null,
        });
      } else if (/UPDATE client_commands/i.test(sql)) {
        const [status, result, error, updatedAt, runningStatus, startedAt, finishedAt, id, userId] = this.params;
        const row = commands.get(String(id));
        if (row && row.user_id === userId) {
          row.status = String(status);
          if (result != null) row.result = String(result);
          row.error = error == null ? null : String(error);
          row.updated_at = String(updatedAt);
          if (!row.started_at && runningStatus === 'running') row.started_at = String(startedAt);
          if (finishedAt != null) row.finished_at = String(finishedAt);
        }
      } else if (/INSERT INTO subscriptions/i.test(sql)) {
        const [id, clientId, delivery, targetUrl, secret, filters, cursor, active, createdAt] = this.params;
        subscriptions.set(String(id), {
          id: String(id),
          client_id: String(clientId),
          delivery: String(delivery),
          target_url: targetUrl == null ? null : String(targetUrl),
          secret: secret == null ? null : String(secret),
          filters: String(filters ?? '{}'),
          cursor: Number(cursor ?? 0),
          active: active ? 1 : 0,
          created_at: String(createdAt),
        });
      }
      return { success: true, meta: { changes: 1 } };
    },
  });

  const env = {
    DB: { prepare } as unknown as D1Database,
    CONFIG_KV: {
      get: async (k: string) => (kv.has(k) ? kv.get(k)! : null),
      put: async (k: string, v: string) => {
        kv.set(k, v);
      },
      delete: async (k: string) => {
        kv.delete(k);
      },
    },
    INGEST_QUEUE: { send: async (_msg: QueueMessage) => {} },
    DELIVERY_QUEUE: { send: async (_msg: QueueMessage) => {} },
  } as unknown as Env;

  return { env, subscriptions, commands, preferences, feedRows };
}

async function bearer(env: Env): Promise<string> {
  return `Bearer ${await createSession(env, 'user_1')}`;
}

describe('client API routes', () => {
  it('serves bootstrap and public feed without sign-in', async () => {
    const { env } = makeEnv();
    const app = buildClientRouter();

    const bootstrap = await app.request('http://localhost/bootstrap', {}, env);
    expect(bootstrap.status).toBe(200);
    expect((await bootstrap.json()) as {
      auth: { user: unknown };
      capabilities: Record<string, boolean>;
      endpoints: Record<string, string>;
    }).toMatchObject({
      auth: { user: null },
      capabilities: {
        feed: true,
        sse: true,
        webhooks: false,
        commands: false,
        preferences: false,
      },
      endpoints: {
        feed: '/api/client/v1/feed',
        commands: '/api/client/v1/commands',
        preferences: '/api/client/v1/preferences',
        subscriptions: '/api/client/v1/subscriptions',
      },
    });

    const feed = await app.request('http://localhost/feed?limit=5', {}, env);
    expect(feed.status).toBe(200);
    expect((await feed.json()) as { items: unknown[] }).toMatchObject({ items: [], cursor: 0 });
  });

  it('accepts bearer sessions for native clients', async () => {
    const { env } = makeEnv();
    const app = buildClientRouter();
    const res = await app.request('http://localhost/me', { headers: { authorization: await bearer(env) } }, env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: { email: string } }).user.email).toBe('mobile@example.com');
  });

  it('returns source document URLs in phone-shaped feed rows', async () => {
    const { env, feedRows } = makeEnv();
    feedRows.push({
      id: 'tx_1',
      doc_id: 'H-2026-20034784',
      filer_id: 'P000197',
      tx_date: '2026-05-05',
      owner: 'spouse',
      asset_name: 'Austin TX ARPT SYS TRAN',
      ticker: null,
      asset_type: 'GS',
      tx_type: 'P',
      amount_min: 50001,
      amount_max: 100000,
      is_option: 0,
      cap_gains_over_200: 0,
      raw_text: 'SP Austin TX ARPT SYS TRAN [GS] P 05/05/2026 05/31/2026 $50,001 - $100,000',
      confidence: 0.9,
      source: 'primary',
      row_key: 'v1:primary:0:example',
      created_at: '2026-06-22T13:01:49.646Z',
      cursor_seq: 7472,
      filer_full_name: 'Scott Peters',
      filer_state: 'CA',
      filer_photo_url: null,
      filing_filed_date: '2026-06-19',
      filing_first_seen_at: '2026-06-22T13:01:15.667Z',
      filing_source_url: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20034784.pdf',
      __chamber: 'house',
      __member_name: 'Scott Peters',
      __party: null,
    } as FeedTransactionRow & { __chamber: string; __member_name: string; __party: null });

    const app = buildClientRouter();
    const res = await app.request('http://localhost/feed?limit=1', {}, env);
    expect(res.status).toBe(200);
    expect((await res.json()) as { items: Array<{ filing: { sourceUrl: string } }> }).toMatchObject({
      items: [
        {
          filing: {
            sourceUrl: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20034784.pdf',
          },
        },
      ],
    });
  });

  it('surfaces company name + same-origin logo URL on enriched feed rows', async () => {
    const { env, feedRows } = makeEnv();
    feedRows.push({
      id: 'tx_2',
      doc_id: 'H-2026-20034836',
      filer_id: 'P000197',
      tx_date: '2026-05-06',
      owner: 'self',
      asset_name: 'Apple Inc. - Common Stock',
      ticker: 'AAPL',
      asset_type: 'ST',
      tx_type: 'P',
      amount_min: 1001,
      amount_max: 15000,
      is_option: 0,
      cap_gains_over_200: 0,
      raw_text: 'Apple',
      confidence: 0.95,
      source: 'primary',
      row_key: 'v1:primary:0:aapl',
      created_at: '2026-06-22T13:01:49.646Z',
      cursor_seq: 7473,
      filer_full_name: 'Scott Peters',
      filer_state: 'CA',
      filer_photo_url: null,
      filing_filed_date: '2026-06-19',
      filing_first_seen_at: '2026-06-22T13:01:15.667Z',
      filing_source_url: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20034836.pdf',
      ref_company_name: 'Apple Inc.',
      ref_sector: 'Technology',
      ref_market_cap_bucket: 'mega',
      __chamber: 'house',
      __member_name: 'Scott Peters',
      __party: null,
    } as FeedTransactionRow & { __chamber: string; __member_name: string; __party: null });

    const app = buildClientRouter();
    const res = await app.request('http://localhost/feed?limit=1', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        asset: { ticker: string | null; companyName: string | null; logoUrl: string | null; sector: string | null };
      }>;
    };
    expect(body.items[0].asset).toMatchObject({
      ticker: 'AAPL',
      companyName: 'Apple Inc.',
      logoUrl: '/api/logos/ticker?symbol=AAPL',
      sector: 'Technology',
    });
  });

  it('emits null company name + logo URL when a row has no resolved ticker', async () => {
    const { env, feedRows } = makeEnv();
    feedRows.push({
      id: 'tx_3',
      doc_id: 'H-2026-20034784',
      filer_id: 'P000197',
      tx_date: '2026-05-05',
      owner: 'spouse',
      asset_name: 'Austin TX ARPT SYS TRAN',
      ticker: null,
      asset_type: 'GS',
      tx_type: 'P',
      amount_min: 50001,
      amount_max: 100000,
      is_option: 0,
      cap_gains_over_200: 0,
      raw_text: 'muni bond',
      confidence: 0.9,
      source: 'primary',
      row_key: 'v1:primary:0:muni',
      created_at: '2026-06-22T13:01:49.646Z',
      cursor_seq: 7474,
      filer_full_name: 'Scott Peters',
      filer_state: 'CA',
      filer_photo_url: null,
      filing_filed_date: '2026-06-19',
      filing_first_seen_at: '2026-06-22T13:01:15.667Z',
      filing_source_url: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20034784.pdf',
      __chamber: 'house',
      __member_name: 'Scott Peters',
      __party: null,
    } as FeedTransactionRow & { __chamber: string; __member_name: string; __party: null });

    const app = buildClientRouter();
    const res = await app.request('http://localhost/feed?limit=1', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ asset: { ticker: string | null; companyName: string | null; logoUrl: string | null } }>;
    };
    expect(body.items[0].asset).toMatchObject({ ticker: null, companyName: null, logoUrl: null });
  });

  it('updates preferences through an authenticated command', async () => {
    const { env, preferences } = makeEnv();
    const app = buildClientRouter();
    const res = await app.request(
      'http://localhost/commands',
      {
        method: 'POST',
        headers: { authorization: await bearer(env), 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'update_preferences',
          payload: { watchlist: ['aapl', 'msft'], defaultWindow: 'all' },
          idempotencyKey: 'prefs-1',
        }),
      },
      env,
    );
    expect(res.status).toBe(201);
    expect((await res.json()) as { command: { status: string } }).toMatchObject({
      command: { status: 'succeeded' },
    });
    expect(JSON.parse(preferences.get('user_1')?.watchlist ?? '[]')).toEqual(['AAPL', 'MSFT']);
  });

  it('creates an SSE subscription command and replays by idempotency key', async () => {
    const { env, subscriptions, commands } = makeEnv();
    const app = buildClientRouter();
    const auth = await bearer(env);
    const req = {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json', 'idempotency-key': 'sub-1' },
      body: JSON.stringify({
        type: 'create_subscription',
        payload: { delivery: 'sse', filters: { tickers: ['aapl'] } },
      }),
    };

    const first = await app.request('http://localhost/commands', req, env);
    expect(first.status).toBe(201);
    const body = (await first.json()) as { result: { subscription: { secret: string; streamUrl: string } } };
    expect(body.result.subscription.secret).toMatch(/^whsec_/);
    expect(body.result.subscription.streamUrl).toContain('/api/stream?subscription=');
    expect(subscriptions.size).toBe(1);
    expect(commands.size).toBe(1);

    const replay = await app.request('http://localhost/commands', req, env);
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { replayed: boolean }).replayed).toBe(true);
    expect(subscriptions.size).toBe(1);
    expect(commands.size).toBe(1);
  });

  it('rejects unsupported client command types with 501', async () => {
    const { env } = makeEnv();
    const app = buildClientRouter();
    const res = await app.request(
      'http://localhost/commands',
      {
        method: 'POST',
        headers: { authorization: await bearer(env), 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'start_checkout',
          payload: {},
          idempotencyKey: 'checkout-1',
        }),
      },
      env,
    );
    expect(res.status).toBe(501);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: 'start_checkout is not implemented yet',
    });
  });
});
