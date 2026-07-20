import { describe, expect, it } from 'vitest';
import { buildClientRouter } from '../routes';
import { createSession } from '../../auth/session';
import { spendRowBudget, DAILY_ROW_BUDGET } from '../../security/botDefense';
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

type FilerRow = {
  bioguide_id: string;
  chamber: string | null;
  full_name: string | null;
  party: string | null;
  state: string | null;
  district: string | null;
  committees: string | null;
  photo_url: string | null;
};

type SecurityRow = {
  ticker: string;
  company_name: string | null;
  sector: string | null;
  industry: string | null;
  asset_class: string | null;
  country: string | null;
  exchange_short: string | null;
  currency: string | null;
  market_cap: number | null;
  market_cap_bucket: string | null;
  current_price: number | null;
  current_price_date: string | null;
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
    subscription_status: 'active',
    plan: 'monthly',
  };
}

function feedRow(overrides: Partial<FeedTransactionRow> & { __chamber?: string } = {}): FeedTransactionRow {
  return {
    id: 'tx_default',
    doc_id: 'H-default',
    filer_id: 'P000197',
    tx_date: '2026-05-05',
    owner: 'self',
    asset_name: 'Apple Inc.',
    ticker: 'AAPL',
    asset_type: 'ST',
    tx_type: 'P',
    amount_min: 15_001,
    amount_max: 50_000,
    is_option: 0,
    cap_gains_over_200: 0,
    raw_text: 'Apple trade',
    confidence: 0.9,
    source: 'primary',
    row_key: 'default',
    created_at: '2026-06-20T00:00:00.000Z',
    cursor_seq: 1,
    est_value: 32_500.5,
    filer_full_name: 'Nancy Pelosi',
    filer_state: 'CA',
    filer_photo_url: null,
    filing_filed_date: '2026-06-19',
    filing_first_seen_at: '2026-06-20T00:00:00.000Z',
    filing_source_url: 'https://example.com/default.pdf',
    ...overrides,
  };
}

function makeEnv(opts: { quotaRace?: boolean; duplicateCommandRace?: boolean; staleReclaimLostRace?: boolean } = {}) {
  const kv = new Map<string, string>();
  const subscriptions = new Map<string, SubscriptionRow>();
  const commands = new Map<string, CommandRow>();
  const preferences = new Map<string, PrefRow>();
  const filers = new Map<string, FilerRow>();
  const securities = new Map<string, SecurityRow>();
  const feedRows: FeedTransactionRow[] = [];
  let duplicateRaceTriggered = false;

  const filterFeedRows = (sql: string, params: unknown[]) => {
    let rows = [...feedRows];
    let i = 0;
    if (/t\.cursor_seq > \?/i.test(sql)) {
      const since = Number(params[i++] ?? 0);
      rows = rows.filter((row) => Number(row.cursor_seq ?? 0) > since);
    }
    if (/t\.id = \?/i.test(sql)) {
      const id = String(params[i++]);
      rows = rows.filter((row) => row.id === id);
    }
    if (/t\.ticker = \?/i.test(sql)) {
      const ticker = String(params[i++]).toUpperCase();
      rows = rows.filter((row) => row.ticker === ticker);
    }
    if (/t\.filer_id = \?/i.test(sql)) {
      const member = String(params[i++]);
      rows = rows.filter((row) => row.filer_id === member);
    }
    if (/LOWER\(COALESCE\(fl\.full_name/i.test(sql)) {
      const memberName = String(params[i++]).replace(/%/g, '').toLowerCase();
      rows = rows.filter((row) => String(row.filer_full_name ?? row.filer_id ?? '').toLowerCase().includes(memberName));
    }
    if (/t\.tx_type = \?/i.test(sql)) {
      const txType = String(params[i++]);
      rows = rows.filter((row) => row.tx_type === txType);
    }
    const chamberIn = sql.match(/COALESCE\(fl\.chamber, f\.chamber\) IN \(([?, ]+)\)/i);
    if (chamberIn) {
      const n = (chamberIn[1].match(/\?/g) ?? []).length;
      const chambers = params.slice(i, i + n).map(String);
      i += n;
      rows = rows.filter((row) => chambers.includes(String((row as FeedTransactionRow & { __chamber?: string }).__chamber)));
    } else if (/COALESCE\(fl\.chamber, f\.chamber\) = \?/i.test(sql)) {
      const chamber = String(params[i++]);
      rows = rows.filter((row) => (row as FeedTransactionRow & { __chamber?: string }).__chamber === chamber);
    } else if (/COALESCE\(fl\.chamber, f\.chamber\) <> 'executive'/i.test(sql)) {
      // Parameter-less default: the congressional view excludes executive rows.
      rows = rows.filter((row) => (row as FeedTransactionRow & { __chamber?: string }).__chamber !== 'executive');
    }
    if (/t\.amount_min >= \?/i.test(sql)) {
      const minAmount = Number(params[i++]);
      rows = rows.filter((row) => row.amount_min != null && row.amount_min >= minAmount);
    }
    if (/t\.amount_min <= \?/i.test(sql)) {
      const maxAmount = Number(params[i++]);
      rows = rows.filter((row) => row.amount_min != null && row.amount_min <= maxAmount);
    }
    if (/ORDER BY[^]*t\.cursor_seq DESC/i.test(sql)) {
      rows.sort((a, b) => Number(b.cursor_seq ?? 0) - Number(a.cursor_seq ?? 0));
    } else if (/ORDER BY[^]*t\.cursor_seq ASC/i.test(sql)) {
      rows.sort((a, b) => Number(a.cursor_seq ?? 0) - Number(b.cursor_seq ?? 0));
    }
    const limit = Number(sql.match(/LIMIT\s+(\d+)/i)?.[1] ?? rows.length);
    return rows.slice(0, limit);
  };

  const midpoint = (row: FeedTransactionRow) => {
    return Number(row.est_value ?? 0);
  };

  const summaryFor = (rows: FeedTransactionRow[]) => {
    const tradeDates = rows.map((row) => row.tx_date).filter((v): v is string => Boolean(v)).sort();
    const uniqueTickers = new Set(rows.map((row) => row.ticker).filter(Boolean));
    const uniqueAssets = new Set(rows.map((row) => row.ticker || row.asset_name).filter(Boolean));
    const estVolume = rows.reduce((sum, row) => sum + midpoint(row), 0);
    const estNetFlow = rows.reduce((sum, row) => {
      const value = midpoint(row);
      if (row.tx_type === 'P') return sum + value;
      if (row.tx_type === 'S') return sum - value;
      return sum;
    }, 0);
    return {
      total_trades: rows.length,
      buy_count: rows.filter((row) => row.tx_type === 'P').length,
      sell_count: rows.filter((row) => row.tx_type === 'S').length,
      exchange_count: rows.filter((row) => row.tx_type === 'E').length,
      member_count: new Set(rows.map((row) => row.filer_id).filter(Boolean)).size,
      unique_tickers: uniqueTickers.size,
      unique_assets: uniqueAssets.size,
      est_volume: estVolume,
      est_net_flow: estNetFlow,
      first_trade: tradeDates[0] ?? null,
      last_trade: tradeDates[tradeDates.length - 1] ?? null,
    };
  };

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
      if (/COUNT\(\*\) AS total/i.test(sql) && /FROM subscriptions WHERE client_id/i.test(sql)) {
        const owned = Array.from(subscriptions.values()).filter((row) => row.client_id === this.params[0]);
        return { total: owned.length, active: owned.filter((row) => row.active === 1).length } as T;
      }
      if (/FROM filers WHERE LOWER\(bioguide_id\) = LOWER\(\?\)/i.test(sql)) {
        const term = String(this.params[0]).toLowerCase();
        const row = Array.from(filers.values()).find((filer) => filer.bioguide_id.toLowerCase() === term);
        return (row ?? null) as T | null;
      }
      if (/FROM filers WHERE LOWER\(full_name\)/i.test(sql)) {
        const exact = String(this.params[0]).toLowerCase();
        const like = String(this.params[1]).replace(/%/g, '').toLowerCase();
        const row = Array.from(filers.values()).find((filer) => filer.full_name?.toLowerCase() === exact) ??
          Array.from(filers.values()).find((filer) => filer.full_name?.toLowerCase().includes(like));
        return (row ?? null) as T | null;
      }
      if (/FROM securities_ref WHERE ticker = \?/i.test(sql)) {
        return (securities.get(String(this.params[0]).toUpperCase()) ?? null) as T | null;
      }
      if (/COUNT\(\*\) AS total_trades/i.test(sql)) {
        return summaryFor(filterFeedRows(sql, this.params)) as T;
      }
      if (/FROM transactions t/i.test(sql) && /t\.id = \?/i.test(sql)) {
        return (filterFeedRows(sql, this.params)[0] ?? null) as T | null;
      }
      if (/COUNT\(\*\) AS total(?:\s|,|$)/i.test(sql)) {
        return { total: filterFeedRows(sql, this.params).length } as T;
      }
      return null as T | null;
    },
    async all<T>() {
      if (/COUNT\(\*\) AS total_trades/i.test(sql)) {
        return { results: [summaryFor(filterFeedRows(sql, this.params)) as T] };
      }
      if (/COUNT\(\*\) AS total/i.test(sql) && /FROM subscriptions WHERE client_id/i.test(sql)) {
        const owned = Array.from(subscriptions.values()).filter((row) => row.client_id === this.params[0]);
        return { results: [{ total: owned.length, active: owned.filter((row) => row.active === 1).length } as T] };
      }
      if (/COUNT\(\*\) AS total(?:\s|,|$)/i.test(sql)) {
        return { results: [{ total: filterFeedRows(sql, this.params).length } as T] };
      }
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
        return { results: filterFeedRows(sql, this.params) as T[] };
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
        const [id, userId, , , idempotencyKey] = this.params;
        if (opts.duplicateCommandRace && !duplicateRaceTriggered) {
          // Simulate a peer request's concurrent INSERT for the same
          // (user_id, idempotency_key) committing first, between our SELECT
          // (which saw nothing) and this INSERT — the unique index backstop.
          duplicateRaceTriggered = true;
          commands.set('cmd_peer_race', {
            id: 'cmd_peer_race',
            user_id: String(userId),
            type: 'update_preferences',
            status: 'succeeded',
            idempotency_key: idempotencyKey == null ? null : String(idempotencyKey),
            payload: '{}',
            result: JSON.stringify({ preferences: {} }),
            error: null,
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:01.000Z',
            started_at: '2026-01-01T00:00:00.000Z',
            finished_at: '2026-01-01T00:00:01.000Z',
          });
          throw new Error('D1_ERROR: UNIQUE constraint failed: client_commands.idempotency_key');
        }
        const [, , type, status, , payload, createdAt, updatedAt] = this.params;
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
      } else if (/UPDATE client_commands/i.test(sql) && /status IN \('queued', 'running'\)/i.test(sql)) {
        const [updatedAt, startedAt, id, userId, staleBefore] = this.params;
        const row = commands.get(String(id));
        if (
          row &&
          row.user_id === userId &&
          (row.status === 'queued' || row.status === 'running') &&
          String(row.started_at ?? row.created_at) < String(staleBefore)
        ) {
          if (opts.staleReclaimLostRace) {
            row.status = 'succeeded';
            row.result = JSON.stringify({ preferences: { defaultWindow: 'peer' } });
            row.updated_at = String(updatedAt);
            row.finished_at = String(updatedAt);
            return { success: true, meta: { changes: 0 } };
          }
          row.status = 'running';
          row.error = null;
          row.updated_at = String(updatedAt);
          row.started_at = String(startedAt);
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 0 } };
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
        if (subscriptions.has(String(id))) {
          throw new Error('D1_ERROR: UNIQUE constraint failed: subscriptions.id');
        }
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
      } else if (/UPDATE subscriptions SET active = \? WHERE id = \?/i.test(sql)) {
        if (opts.quotaRace) throw new Error('D1_ERROR: subscription active quota exceeded');
        const row = subscriptions.get(String(this.params[1]));
        if (row) row.active = this.params[0] ? 1 : 0;
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
    INGEST_QUEUE: { send: async (_msg: QueueMessage) => {}, sendBatch: async () => {} },
    DELIVERY_QUEUE: { send: async (_msg: QueueMessage) => {}, sendBatch: async () => {} },
  } as unknown as Env;

  return { env, subscriptions, commands, preferences, filers, securities, feedRows };
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
        trade: '/api/client/v1/trade/:id',
        ticker: '/api/client/v1/ticker/:ticker',
        member: '/api/client/v1/member/:memberIdOrName',
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

  it('serves latest-first server-filtered feed rows with estimated value', async () => {
    const { env, feedRows } = makeEnv();
    feedRows.push(
      feedRow({ id: 'matching-old', cursor_seq: 10, __chamber: 'house' }),
      feedRow({ id: 'matching-new', cursor_seq: 12, est_value: 40_000, __chamber: 'house' }),
      feedRow({ id: 'wrong-chamber', cursor_seq: 13, __chamber: 'senate' }),
      feedRow({ id: 'wrong-amount', cursor_seq: 14, amount_min: 50_001, amount_max: 100_000, __chamber: 'house' }),
    );

    const app = buildClientRouter();
    const res = await app.request(
      'http://localhost/feed?limit=30&sort=published&order=desc&ticker=AAPL&memberName=pelosi&chamber=house&minAmount=15001&maxAmount=50000',
      {},
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ id: string; transaction: { estValue: number | null } }>;
      total: number;
    };
    expect(body.items.map((item) => item.id)).toEqual(['matching-new', 'matching-old']);
    expect(body.items[0].transaction.estValue).toBe(40_000);
    expect(body.total).toBe(2);
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
      est_value: 75001,
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

  it('surfaces enriched sector and market cap on feed rows', async () => {
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
      est_value: 8000,
    } as FeedTransactionRow & { __chamber: string; __member_name: string; __party: null });

    const app = buildClientRouter();
    const res = await app.request('http://localhost/feed?limit=1', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        asset: {
          ticker: string | null;
          sector: string | null;
        };
      }>;
    };
    expect(body.items[0].asset).toMatchObject({
      ticker: 'AAPL',
      sector: 'Technology',
    });
  });

  it('emits null ticker when a row has no resolved ticker', async () => {
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
      est_value: 75001,
    } as FeedTransactionRow & { __chamber: string; __member_name: string; __party: null });

    const app = buildClientRouter();
    const res = await app.request('http://localhost/feed?limit=1', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        asset: {
          ticker: string | null;
        };
      }>;
    };
    expect(body.items[0].asset).toMatchObject({
      ticker: null,
    });
  });

  it('returns a public trade detail envelope with the client trade DTO', async () => {
    const { env, feedRows } = makeEnv();
    feedRows.push({
      id: 'tx_detail',
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
      __party: 'D',
      est_value: 8000,
    } as FeedTransactionRow & { __chamber: string; __member_name: string; __party: string });

    const app = buildClientRouter();
    const res = await app.request('http://localhost/trade/tx_detail', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      item: { id: string; member: { name: string; party: string }; asset: { ticker: string | null } };
      items: unknown[];
      count: number;
      total: number;
    };
    expect(body.item).toMatchObject({
      id: 'tx_detail',
      member: { name: 'Scott Peters', party: 'D' },
      asset: { ticker: 'AAPL' },
    });
    expect(body.items).toHaveLength(1);
    expect(body.count).toBe(1);
    expect(body.total).toBe(1);
  });

  it('returns a public ticker detail envelope with summary and recent trades', async () => {
    const { env, feedRows, securities } = makeEnv();
    securities.set('AAPL', {
      ticker: 'AAPL',
      company_name: 'Apple Inc.',
      sector: 'Technology',
      industry: 'Consumer Electronics',
      asset_class: 'equity',
      country: 'US',
      exchange_short: 'NASDAQ',
      currency: 'USD',
      market_cap: 3000000000000,
      market_cap_bucket: 'mega',
      current_price: 210.25,
      current_price_date: '2026-06-29',
    });
    feedRows.push(
      {
        id: 'tx_aapl_old',
        doc_id: 'H-1',
        filer_id: 'P000197',
        tx_date: '2026-05-01',
        owner: 'self',
        asset_name: 'Apple Inc.',
        ticker: 'AAPL',
        asset_type: 'ST',
        tx_type: 'P',
        amount_min: 1001,
        amount_max: 15000,
        is_option: 0,
        cap_gains_over_200: 0,
        raw_text: 'Apple buy',
        confidence: 0.95,
        source: 'primary',
        row_key: 'old',
        created_at: '2026-06-20T00:00:00.000Z',
        cursor_seq: 10,
        filer_full_name: 'Scott Peters',
        filer_state: 'CA',
        filer_photo_url: null,
        filing_filed_date: '2026-06-19',
        filing_first_seen_at: '2026-06-20T00:00:00.000Z',
        filing_source_url: 'https://example.com/old.pdf',
        __chamber: 'house',
        __member_name: 'Scott Peters',
        __party: 'D',
        est_value: 8000,
      } as FeedTransactionRow & { __chamber: string; __member_name: string; __party: string },
      {
        id: 'tx_aapl_new',
        doc_id: 'H-2',
        filer_id: 'N000188',
        tx_date: '2026-05-03',
        owner: 'spouse',
        asset_name: 'Apple Inc.',
        ticker: 'AAPL',
        asset_type: 'ST',
        tx_type: 'S',
        amount_min: 15001,
        amount_max: 50000,
        is_option: 0,
        cap_gains_over_200: 0,
        raw_text: 'Apple sell',
        confidence: 0.9,
        source: 'primary',
        row_key: 'new',
        created_at: '2026-06-21T00:00:00.000Z',
        cursor_seq: 12,
        filer_full_name: 'Nancy Pelosi',
        filer_state: 'CA',
        filer_photo_url: null,
        filing_filed_date: '2026-06-20',
        filing_first_seen_at: '2026-06-21T00:00:00.000Z',
        filing_source_url: 'https://example.com/new.pdf',
        __chamber: 'house',
        __member_name: 'Nancy Pelosi',
        __party: 'D',
        est_value: 32501,
      } as FeedTransactionRow & { __chamber: string; __member_name: string; __party: string },
      {
        id: 'tx_msft',
        doc_id: 'H-3',
        filer_id: 'P000197',
        tx_date: '2026-05-04',
        owner: 'self',
        asset_name: 'Microsoft Corp.',
        ticker: 'MSFT',
        asset_type: 'ST',
        tx_type: 'P',
        amount_min: 1001,
        amount_max: 15000,
        is_option: 0,
        cap_gains_over_200: 0,
        raw_text: 'Microsoft buy',
        confidence: 0.9,
        source: 'primary',
        row_key: 'msft',
        created_at: '2026-06-22T00:00:00.000Z',
        cursor_seq: 13,
        filer_full_name: 'Scott Peters',
        filer_state: 'CA',
        filer_photo_url: null,
        filing_filed_date: '2026-06-21',
        filing_first_seen_at: '2026-06-22T00:00:00.000Z',
        filing_source_url: 'https://example.com/msft.pdf',
        __chamber: 'house',
        __member_name: 'Scott Peters',
        __party: 'D',
        est_value: 8000,
      } as FeedTransactionRow & { __chamber: string; __member_name: string; __party: string },
    );

    const app = buildClientRouter();
    const res = await app.request('http://localhost/ticker/aapl?limit=1', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ticker: string;
      asset: { companyName: string | null; logoUrl: string | null; currentPrice: number | null };
      summary: { totalTrades: number; buyCount: number; sellCount: number; memberCount: number };
      items: Array<{ id: string; asset: { ticker: string | null } }>;
      count: number;
      total: number;
    };
    expect(body.ticker).toBe('AAPL');
    expect(body.asset).toMatchObject({
      companyName: 'Apple Inc.',
      logoUrl: '/api/logos/ticker?symbol=AAPL',
      currentPrice: 210.25,
    });
    expect(body.summary).toMatchObject({ totalTrades: 2, buyCount: 1, sellCount: 1, memberCount: 2 });
    expect(body.items).toEqual([
      expect.objectContaining({ id: 'tx_aapl_new', asset: expect.objectContaining({ ticker: 'AAPL' }) }),
    ]);
    expect(body.count).toBe(1);
    expect(body.total).toBe(2);
  });

  it('returns a public politician detail envelope by member endpoint/name', async () => {
    const { env, feedRows, filers } = makeEnv();
    filers.set('P000197', {
      bioguide_id: 'P000197',
      chamber: 'house',
      full_name: 'Scott Peters',
      party: 'D',
      state: 'CA',
      district: '50',
      committees: JSON.stringify(['Energy and Commerce']),
      photo_url: 'https://example.com/peters.jpg',
    });
    feedRows.push(
      {
        id: 'tx_member_1',
        doc_id: 'H-4',
        filer_id: 'P000197',
        tx_date: '2026-04-01',
        owner: 'self',
        asset_name: 'Apple Inc.',
        ticker: 'AAPL',
        asset_type: 'ST',
        tx_type: 'P',
        amount_min: 1001,
        amount_max: 15000,
        is_option: 0,
        cap_gains_over_200: 0,
        raw_text: 'Apple buy',
        confidence: 0.95,
        source: 'primary',
        row_key: 'member-1',
        created_at: '2026-06-18T00:00:00.000Z',
        cursor_seq: 20,
        filer_full_name: 'Scott Peters',
        filer_state: 'CA',
        filer_photo_url: 'https://example.com/peters.jpg',
        filing_filed_date: '2026-06-18',
        filing_first_seen_at: '2026-06-18T00:00:00.000Z',
        filing_source_url: 'https://example.com/member1.pdf',
        __chamber: 'house',
        __member_name: 'Scott Peters',
        __party: 'D',
        est_value: 8000,
      } as FeedTransactionRow & { __chamber: string; __member_name: string; __party: string },
      {
        id: 'tx_member_2',
        doc_id: 'H-5',
        filer_id: 'P000197',
        tx_date: '2026-04-03',
        owner: 'self',
        asset_name: 'Microsoft Corp.',
        ticker: 'MSFT',
        asset_type: 'ST',
        tx_type: 'S',
        amount_min: 15001,
        amount_max: 50000,
        is_option: 0,
        cap_gains_over_200: 0,
        raw_text: 'Microsoft sell',
        confidence: 0.9,
        source: 'primary',
        row_key: 'member-2',
        created_at: '2026-06-19T00:00:00.000Z',
        cursor_seq: 21,
        filer_full_name: 'Scott Peters',
        filer_state: 'CA',
        filer_photo_url: 'https://example.com/peters.jpg',
        filing_filed_date: '2026-06-19',
        filing_first_seen_at: '2026-06-19T00:00:00.000Z',
        filing_source_url: 'https://example.com/member2.pdf',
        __chamber: 'house',
        __member_name: 'Scott Peters',
        __party: 'D',
        est_value: 32501,
      } as FeedTransactionRow & { __chamber: string; __member_name: string; __party: string },
    );

    const app = buildClientRouter();
    const res = await app.request('http://localhost/member/Scott%20Peters?limit=2', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      member: { id: string; name: string; chamber: string; committees: string[] };
      summary: { totalTrades: number; uniqueTickers: number; uniqueAssets: number };
      items: Array<{ member: { id: string | null } }>;
      total: number;
    };
    expect(body.member).toMatchObject({
      id: 'P000197',
      name: 'Scott Peters',
      chamber: 'house',
      committees: ['Energy and Commerce'],
    });
    expect(body.summary).toMatchObject({ totalTrades: 2, uniqueTickers: 2, uniqueAssets: 2 });
    expect(body.items.map((item) => item.member.id)).toEqual(['P000197', 'P000197']);
    expect(body.total).toBe(2);
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
    const body = (await first.json()) as {
      command: { result: { subscription: { secret?: string; streamUrl?: string; hasSecret: boolean } } };
      result: { subscription: { secret: string; streamUrl: string } };
    };
    expect(body.result.subscription.secret).toMatch(/^whsec_/);
    expect(body.result.subscription.streamUrl).toContain('/api/stream?subscription=');
    expect(body.command.result.subscription.hasSecret).toBe(true);
    expect(body.command.result.subscription.secret).toBeUndefined();
    expect(body.command.result.subscription.streamUrl).toBeUndefined();
    expect(subscriptions.size).toBe(1);
    expect(commands.size).toBe(1);
    const persisted = JSON.parse(Array.from(commands.values())[0].result ?? '{}') as {
      subscription: { secret?: string; streamUrl?: string; hasSecret: boolean };
    };
    expect(persisted.subscription.hasSecret).toBe(true);
    expect(persisted.subscription.secret).toBeUndefined();
    expect(persisted.subscription.streamUrl).toBeUndefined();
    expect(JSON.stringify(persisted)).not.toContain(body.result.subscription.secret);

    const replay = await app.request('http://localhost/commands', req, env);
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as {
      replayed: boolean;
      command: { result: { subscription: { secret?: string; streamUrl?: string; hasSecret: boolean } } };
    };
    expect(replayBody.replayed).toBe(true);
    expect(replayBody.command.result.subscription.hasSecret).toBe(true);
    expect(replayBody.command.result.subscription.secret).toBeUndefined();
    expect(replayBody.command.result.subscription.streamUrl).toBeUndefined();
    expect(JSON.stringify(replayBody)).not.toContain(body.result.subscription.secret);
    expect(subscriptions.size).toBe(1);
    expect(commands.size).toBe(1);
  });

  it('enforces the same durable quota and bounded filters on client commands', async () => {
    const { env, subscriptions } = makeEnv();
    for (let i = 0; i < 20; i += 1) {
      subscriptions.set(`sub_${i}`, {
        id: `sub_${i}`, client_id: 'user:user_1', delivery: 'sse', target_url: null,
        secret: `secret_${i}`, filters: '{}', cursor: 0, active: i < 10 ? 1 : 0,
        created_at: '2026-01-01T00:00:00.000Z',
      });
    }
    const app = buildClientRouter();
    const auth = await bearer(env);
    const limited = await app.request('http://localhost/commands', {
      method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'create_subscription', payload: { delivery: 'sse', filters: {} } }),
    }, env);
    expect(limited.status).toBe(409);

    subscriptions.clear();
    const invalid = await app.request('http://localhost/commands', {
      method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'create_subscription', payload: { delivery: 'sse', filters: { tickers: Array(51).fill('A') } } }),
    }, env);
    expect(invalid.status).toBe(400);
  });

  it('rejects oversized webhook targets in client create and update commands', async () => {
    const { env, subscriptions } = makeEnv();
    const app = buildClientRouter();
    const auth = await bearer(env);
    const oversized = `https://example.com/${'x'.repeat(2049)}`;
    const create = await app.request('http://localhost/commands', {
      method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'create_subscription', payload: { delivery: 'webhook', targetUrl: oversized, filters: {} } }),
    }, env);
    expect(create.status).toBe(400);

    subscriptions.set('sub_webhook', {
      id: 'sub_webhook', client_id: 'user:user_1', delivery: 'webhook', target_url: 'https://example.com/hook',
      secret: 'secret', filters: '{}', cursor: 0, active: 1, created_at: '2026-01-01T00:00:00.000Z',
    });
    const update = await app.request('http://localhost/commands', {
      method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'update_subscription', payload: { id: 'sub_webhook', targetUrl: oversized } }),
    }, env);
    expect(update.status).toBe(400);
  });

  it('returns 409 when the active-quota trigger wins a client update race', async () => {
    const { env, subscriptions } = makeEnv({ quotaRace: true });
    subscriptions.set('sub_inactive', {
      id: 'sub_inactive', client_id: 'user:user_1', delivery: 'sse', target_url: null,
      secret: 'secret', filters: '{}', cursor: 0, active: 0,
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const app = buildClientRouter();
    const res = await app.request('http://localhost/commands', {
      method: 'POST',
      headers: { authorization: await bearer(env), 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'update_subscription',
        payload: { id: 'sub_inactive', active: true },
      }),
    }, env);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('active subscription limit');
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

  it('replays the winning row instead of 500ing when a concurrent duplicate command wins the idempotency race', async () => {
    const { env, commands } = makeEnv({ duplicateCommandRace: true });
    const app = buildClientRouter();
    const res = await app.request(
      'http://localhost/commands',
      {
        method: 'POST',
        headers: { authorization: await bearer(env), 'content-type': 'application/json', 'idempotency-key': 'race-1' },
        body: JSON.stringify({ type: 'update_preferences', payload: { defaultWindow: 'all' } }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { replayed: boolean; command: { id: string; status: string } };
    expect(body.replayed).toBe(true);
    expect(body.command.id).toBe('cmd_peer_race');
    expect(body.command.status).toBe('succeeded');
    // Only the peer's row exists — our own losing insert never landed.
    expect(commands.size).toBe(1);
  });

  it('reclaims and re-runs a stale running command instead of replaying a dead status forever', async () => {
    const { env, commands } = makeEnv();
    commands.set('cmd_stale', {
      id: 'cmd_stale',
      user_id: 'user_1',
      type: 'update_preferences',
      status: 'running',
      idempotency_key: 'stale-1',
      payload: JSON.stringify({ defaultWindow: '30d' }),
      result: null,
      error: null,
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-01-01T00:00:00.000Z',
      started_at: '2020-01-01T00:00:00.000Z',
      finished_at: null,
    });
    const app = buildClientRouter();
    const res = await app.request(
      'http://localhost/commands',
      {
        method: 'POST',
        headers: { authorization: await bearer(env), 'content-type': 'application/json', 'idempotency-key': 'stale-1' },
        body: JSON.stringify({ type: 'update_preferences', payload: { defaultWindow: 'all' } }),
      },
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { replayed?: boolean; command: { id: string; status: string } };
    expect(body.command.id).toBe('cmd_stale');
    expect(body.command.status).toBe('succeeded');
    expect(body.replayed).toBeUndefined();
    // The same row was reused (reclaimed), not duplicated.
    expect(commands.size).toBe(1);
  });

  it('replays the winner when a concurrent retry already reclaimed a stale command', async () => {
    const { env, commands, preferences } = makeEnv({ staleReclaimLostRace: true });
    commands.set('cmd_stale_lost', {
      id: 'cmd_stale_lost',
      user_id: 'user_1',
      type: 'update_preferences',
      status: 'running',
      idempotency_key: 'stale-lost-1',
      payload: JSON.stringify({ defaultWindow: '30d' }),
      result: null,
      error: null,
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-01-01T00:00:00.000Z',
      started_at: '2020-01-01T00:00:00.000Z',
      finished_at: null,
    });
    const app = buildClientRouter();
    const res = await app.request(
      'http://localhost/commands',
      {
        method: 'POST',
        headers: { authorization: await bearer(env), 'content-type': 'application/json', 'idempotency-key': 'stale-lost-1' },
        body: JSON.stringify({ type: 'update_preferences', payload: { defaultWindow: 'all' } }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { replayed: boolean; command: { id: string; status: string } };
    expect(body.replayed).toBe(true);
    expect(body.command.id).toBe('cmd_stale_lost');
    expect(body.command.status).toBe('succeeded');
    expect(preferences.size).toBe(0);
  });

  it('replays an already-created subscription when a stale command is retried after side effects landed', async () => {
    const { env, commands, subscriptions } = makeEnv();
    commands.set('cmd_recover_sub', {
      id: 'cmd_recover_sub',
      user_id: 'user_1',
      type: 'create_subscription',
      status: 'running',
      idempotency_key: 'sub-stale-1',
      payload: JSON.stringify({ delivery: 'sse', filters: { tickers: ['AAPL'] } }),
      result: null,
      error: null,
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-01-01T00:00:00.000Z',
      started_at: '2020-01-01T00:00:00.000Z',
      finished_at: null,
    });
    subscriptions.set('sub_recover_sub', {
      id: 'sub_recover_sub',
      client_id: 'user:user_1',
      delivery: 'sse',
      target_url: null,
      secret: 'whsec_existing',
      filters: JSON.stringify({ tickers: ['AAPL'] }),
      cursor: 0,
      active: 1,
      created_at: '2020-01-01T00:00:05.000Z',
    });
    const app = buildClientRouter();
    const res = await app.request(
      'http://localhost/commands',
      {
        method: 'POST',
        headers: { authorization: await bearer(env), 'content-type': 'application/json', 'idempotency-key': 'sub-stale-1' },
        body: JSON.stringify({ type: 'create_subscription', payload: { delivery: 'sse', filters: { tickers: ['MSFT'] } } }),
      },
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      result: { subscription: { id: string; secret?: string; filters: { tickers?: string[] } } };
      command: { status: string; result: { subscription: { hasSecret: boolean; secret?: string } } };
    };
    expect(body.result.subscription.id).toBe('sub_recover_sub');
    expect(body.result.subscription.secret).toBe('whsec_existing');
    expect(body.result.subscription.filters.tickers).toEqual(['AAPL']);
    expect(body.command.status).toBe('succeeded');
    expect(body.command.result.subscription.hasSecret).toBe(true);
    expect(body.command.result.subscription.secret).toBeUndefined();
    expect(subscriptions.size).toBe(1);
  });

  it('replays a genuinely in-flight (recent) running command without re-executing it', async () => {
    const { env, commands } = makeEnv();
    const recentTs = new Date().toISOString();
    commands.set('cmd_inflight', {
      id: 'cmd_inflight',
      user_id: 'user_1',
      type: 'update_preferences',
      status: 'running',
      idempotency_key: 'inflight-1',
      payload: '{}',
      result: null,
      error: null,
      created_at: recentTs,
      updated_at: recentTs,
      started_at: recentTs,
      finished_at: null,
    });
    const app = buildClientRouter();
    const res = await app.request(
      'http://localhost/commands',
      {
        method: 'POST',
        headers: { authorization: await bearer(env), 'content-type': 'application/json', 'idempotency-key': 'inflight-1' },
        body: JSON.stringify({ type: 'update_preferences', payload: { defaultWindow: 'all' } }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { replayed: boolean; command: { status: string } };
    expect(body.replayed).toBe(true);
    expect(body.command.status).toBe('running');
    expect(commands.size).toBe(1);
  });
});

describe('client API detail endpoints: row budget + zero-delta polling', () => {
  it('applies the shared daily row budget to trade/ticker/member detail reads', async () => {
    const { env } = makeEnv();
    // Budget enforcement happens before any DB read in each handler, so an
    // otherwise-empty DB is enough to prove the gate is wired up.
    const guardedEnv = { ...env, SCRAPE_GUARD_ENABLED: 'true' } as unknown as Env;
    const ip = '203.0.113.50';
    await spendRowBudget(guardedEnv, ip, DAILY_ROW_BUDGET);

    const app = buildClientRouter();
    const headers = { 'cf-connecting-ip': ip };
    const trade = await app.request('http://localhost/trade/tx_budget', { headers }, guardedEnv);
    expect(trade.status).toBe(429);
    const ticker = await app.request('http://localhost/ticker/AAPL', { headers }, guardedEnv);
    expect(ticker.status).toBe(429);
    const member = await app.request('http://localhost/member/P000197', { headers }, guardedEnv);
    expect(member.status).toBe(429);
  });

  it('omits total on a zero-delta since-poll instead of paying for a full COUNT(*)', async () => {
    const { env, feedRows } = makeEnv();
    feedRows.push(feedRow({ id: 'tx_1', cursor_seq: 5, __chamber: 'house' }));
    const app = buildClientRouter();
    // since=100 is past every row's cursor -> zero new rows.
    const res = await app.request('http://localhost/feed?since=100', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total?: number; count: number };
    expect(body.items).toHaveLength(0);
    expect(body.count).toBe(0);
    expect(body.total).toBeUndefined();
  });

  it('still computes total on a since-poll that DOES return new rows', async () => {
    const { env, feedRows } = makeEnv();
    feedRows.push(feedRow({ id: 'tx_1', cursor_seq: 5, __chamber: 'house' }));
    const app = buildClientRouter();
    const res = await app.request('http://localhost/feed?since=0', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total?: number };
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(1);
  });
});
