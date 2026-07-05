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
  };
}

function makeEnv() {
  const kv = new Map<string, string>();
  const subscriptions = new Map<string, SubscriptionRow>();
  const commands = new Map<string, CommandRow>();
  const preferences = new Map<string, PrefRow>();
  const filers = new Map<string, FilerRow>();
  const securities = new Map<string, SecurityRow>();
  const feedRows: FeedTransactionRow[] = [];

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
    if (/ORDER BY[^]*t\.cursor_seq DESC/i.test(sql)) {
      rows.sort((a, b) => Number(b.cursor_seq ?? 0) - Number(a.cursor_seq ?? 0));
    } else if (/ORDER BY[^]*t\.cursor_seq ASC/i.test(sql)) {
      rows.sort((a, b) => Number(a.cursor_seq ?? 0) - Number(b.cursor_seq ?? 0));
    }
    const limit = Number(sql.match(/LIMIT\s+(\d+)/i)?.[1] ?? rows.length);
    return rows.slice(0, limit);
  };

  const midpoint = (row: FeedTransactionRow) => {
    if (row.amount_min == null && row.amount_max == null) return 0;
    if (row.amount_min == null) return Number(row.amount_max ?? 0);
    if (row.amount_max == null) return Number(row.amount_min);
    return (Number(row.amount_min) + Number(row.amount_max)) / 2;
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
        asset: {
          ticker: string | null;
          companyName: string | null;
          logoUrl: string | null;
          sector: string | null;
          typeCategory: string;
          typeCategoryLabel: string;
        };
      }>;
    };
    expect(body.items[0].asset).toMatchObject({
      ticker: 'AAPL',
      companyName: 'Apple Inc.',
      logoUrl: '/api/logos/ticker?symbol=AAPL',
      sector: 'Technology',
      typeCategory: 'public_equity',
      typeCategoryLabel: 'Public Equity',
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
      items: Array<{
        asset: {
          ticker: string | null;
          companyName: string | null;
          logoUrl: string | null;
          typeCategory: string;
          typeCategoryLabel: string;
        };
      }>;
    };
    expect(body.items[0].asset).toMatchObject({
      ticker: null,
      companyName: null,
      logoUrl: null,
      typeCategory: 'fixed_income_government',
      typeCategoryLabel: 'Government / Municipal Debt',
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
    } as FeedTransactionRow & { __chamber: string; __member_name: string; __party: string });

    const app = buildClientRouter();
    const res = await app.request('http://localhost/trade/tx_detail', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      item: { id: string; member: { name: string; party: string }; asset: { logoUrl: string | null; companyName: string | null } };
      items: unknown[];
      count: number;
      total: number;
    };
    expect(body.item).toMatchObject({
      id: 'tx_detail',
      member: { name: 'Scott Peters', party: 'D' },
      asset: { companyName: 'Apple Inc.', logoUrl: '/api/logos/ticker?symbol=AAPL' },
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
