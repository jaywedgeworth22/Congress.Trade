import { describe, expect, it } from 'vitest';
import { buildClientRouter } from '../routes';
import { createSession } from '../../auth/session';
import type { Env, QueueMessage } from '../../shared/types';
import type { SubscriptionRow } from '../../delivery/rows';
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
        return { total: 0 } as T;
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

  return { env, subscriptions, commands, preferences };
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
    expect(((await bootstrap.json()) as { auth: { user: unknown } }).auth.user).toBeNull();

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
});
