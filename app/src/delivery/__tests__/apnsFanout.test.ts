import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Env } from '../../shared/types.ts';
import type { ApnsHttpRequest } from '../../shared/apns.ts';
import { openMigratedD1, type SqliteDatabase } from '../../prices/__tests__/sqliteD1.ts';
import {
  APNS_FANOUT_TRADE_SQL,
  fanOutApnsProductEvents,
  inspectApnsFanoutDiagnostics,
  readApnsFanoutLastError,
} from '../apnsFanout.ts';

const pem = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

const liveToken = 'a'.repeat(64);
const deadToken = 'b'.repeat(64);

function mockEnv(opts: {
  devices?: Array<{ token: string; env?: string; userId?: string; active?: number }>;
  trades?: Array<Record<string, unknown>>;
  reviews?: Array<Record<string, unknown>>;
}): Env {
  const devices = (opts.devices ?? []).map((d, i) => ({
    id: `pdev_${i}`,
    user_id: d.userId ?? 'user_1',
    platform: 'apns',
    token: d.token,
    app_bundle: 'trade.congress.ios',
    env: d.env ?? 'production',
    active: d.active ?? 1,
    created_at: '2026-08-13T00:00:00.000Z',
    updated_at: '2026-08-13T00:00:00.000Z',
  }));
  const trades = opts.trades ?? [];
  const reviews = opts.reviews ?? [];

  const prepare = (sql: string) => {
    const stmt = {
      params: [] as unknown[],
      bind(...params: unknown[]) {
        this.params = params;
        return this;
      },
      async first<T>() {
        if (/FROM push_devices WHERE id = \? AND user_id = \?/i.test(sql)) {
          const row = devices.find((d) => d.id === this.params[0] && d.user_id === this.params[1]);
          return (row ?? null) as T | null;
        }
        return null as T | null;
      },
      async all<T>() {
        if (/FROM push_devices\s+WHERE platform = 'apns' AND active = 1/i.test(sql)) {
          return { results: devices.filter((d) => d.active === 1) as T[], meta: {} };
        }
        if (/FROM delivery_outbox o/i.test(sql)) {
          const since = String(this.params[0] ?? '');
          return {
            results: trades.filter((t) => String(t.created_at) > since) as T[],
            meta: {},
          };
        }
        if (/FROM review_queue/i.test(sql)) {
          const since = String(this.params[0] ?? '');
          return {
            results: reviews.filter((r) => String(r.created_at) > since) as T[],
            meta: {},
          };
        }
        return { results: [] as T[], meta: {} };
      },
      async run() {
        if (/UPDATE push_devices SET active = 0/i.test(sql)) {
          const token = String(this.params[this.params.length - 1] ?? '');
          const userId = String(this.params[1] ?? '');
          for (const d of devices) {
            if (d.user_id === userId && d.token === token) d.active = 0;
          }
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
    };
    return stmt;
  };

  return {
    DB: { prepare } as unknown as Env['DB'],
    CONFIG_KV: {
      async get() {
        return null;
      },
      async put() {
        return undefined;
      },
    } as unknown as Env['CONFIG_KV'],
  } as Env;
}

const config = {
  keyId: 'P4US7YTWH4',
  teamId: 'CC8UTF7ATG',
  bundleId: 'trade.congress.ios',
  privateKeyPem: pem,
};

describe('fanOutApnsProductEvents', () => {

  it('no-ops when APNs is not configured', async () => {
    const result = await fanOutApnsProductEvents(mockEnv({}), {
      loadConfig: () => null,
      now: new Date('2026-08-13T18:00:00.000Z'),
    });
    expect(result.skipped).toBe('not_configured');
  });

  it('sends official-trade and review-needed pushes through the mocked transport', async () => {
    const env = mockEnv({
      devices: [
        { token: liveToken, env: 'production' },
        { token: deadToken, env: 'sandbox' },
      ],
      trades: [
        {
          id: 'tx_1',
          ticker: 'NVDA',
          tx_type: 'P',
          asset_name: 'NVIDIA Corp',
          created_at: '2026-08-13T17:30:00.000Z',
          filer_name: 'Jane Pelosi',
        },
      ],
      reviews: [
        {
          doc_id: 'H-99',
          reason: 'Low-confidence extraction',
          created_at: '2026-08-13T17:40:00.000Z',
        },
      ],
    });
    const calls: ApnsHttpRequest[] = [];
    const result = await fanOutApnsProductEvents(env, {
      loadConfig: () => config,
      now: new Date('2026-08-13T18:00:00.000Z'),
      readState: async () => ({
        lastTradeAt: '2026-08-13T16:00:00.000Z',
        lastReviewAt: '2026-08-13T16:00:00.000Z',
      }),
      writeState: async () => undefined,
      transport: async (req) => {
        calls.push(req);
        if (req.path.endsWith(deadToken)) {
          return { status: 410, body: JSON.stringify({ reason: 'Unregistered' }) };
        }
        return { status: 200, body: '' };
      },
    });

    expect(result.skipped).toBeUndefined();
    expect(result.trades).toBe(1);
    expect(result.reviews).toBe(1);
    expect(result.delivered).toBe(2);
    expect(result.retired).toBe(2);
    expect(calls).toHaveLength(4);
    const titles = calls.map((c) => (JSON.parse(c.body) as { aps: { alert: { title: string } } }).aps.alert.title);
    expect(titles).toContain('Jane Pelosi bought NVDA');
    expect(titles).toContain('Review needed');
    expect(calls[0]?.headers['apns-topic']).toBe('trade.congress.ios');
  });

  it('persists the lane error when fan-out throws after devices are listed', async () => {
    const kv = new Map<string, string>();
    const env = mockEnv({ devices: [{ token: liveToken }] });
    env.CONFIG_KV = {
      async get(key: string) {
        return kv.get(key) ?? null;
      },
      async put(key: string, value: string) {
        kv.set(key, value);
      },
    } as unknown as Env['CONFIG_KV'];

    await expect(
      fanOutApnsProductEvents(env, {
        loadConfig: () => config,
        now: new Date('2026-08-13T18:00:00.000Z'),
        readState: async () => {
          throw new Error('no such column: f.id');
        },
        writeState: async () => undefined,
      }),
    ).rejects.toThrow(/no such column: f\.id/);

    await expect(readApnsFanoutLastError(env)).resolves.toMatchObject({
      message: 'no such column: f.id',
      at: '2026-08-13T18:00:00.000Z',
    });
  });
});

const BROKEN_FILERS_ID_SQL = APNS_FANOUT_TRADE_SQL.replace(
  'LEFT JOIN filers f ON f.bioguide_id = t.filer_id',
  'LEFT JOIN filers f ON f.id = t.filer_id',
);

function seedOfficialTrade(db: SqliteDatabase): void {
  db.prepare(
    `INSERT INTO filers (bioguide_id, chamber, full_name, display_name)
     VALUES (?, 'house', ?, ?)`,
  ).run('P000197', 'Nancy Pelosi', 'Nancy Pelosi');
  db.prepare(
    `INSERT INTO transactions
       (id, doc_id, filer_id, ticker, tx_type, asset_name, created_at, deprecated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    'tx_real_1',
    'H-1',
    'P000197',
    'NVDA',
    'P',
    'NVIDIA Corp',
    '2026-08-13T17:30:00.000Z',
  );
  db.prepare(
    `INSERT INTO delivery_outbox (tx_id, status, available_at, created_at, updated_at)
     VALUES (?, 'completed', ?, ?, ?)`,
  ).run(
    'tx_real_1',
    '2026-08-13T17:30:00.000Z',
    '2026-08-13T17:30:00.000Z',
    '2026-08-13T17:30:00.000Z',
  );
}

describe('APNS_FANOUT_TRADE_SQL against real migrations', () => {
  let close = (): void => undefined;

  afterEach(() => {
    close();
  });

  it('throws on f.id and returns COALESCE(display_name, full_name) on bioguide_id', async () => {
    const opened = await openMigratedD1();
    close = opened.close;
    seedOfficialTrade(opened.db);

    expect(() => opened.db.prepare(BROKEN_FILERS_ID_SQL).all('2026-08-13T16:00:00.000Z')).toThrow(
      /no such column: f\.id/i,
    );

    const rows = opened.db.prepare(APNS_FANOUT_TRADE_SQL).all('2026-08-13T16:00:00.000Z') as Array<{
      id: string;
      ticker: string;
      filer_name: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'tx_real_1',
      ticker: 'NVDA',
      filer_name: 'Nancy Pelosi',
    });
    expect(APNS_FANOUT_TRADE_SQL).toContain('LEFT JOIN filers f ON f.bioguide_id = t.filer_id');
    expect(APNS_FANOUT_TRADE_SQL).not.toContain('f.id = t.filer_id');
  });

  it('fan-out executes the real SQL and calls sendAll with the joined name', async () => {
    const opened = await openMigratedD1();
    close = opened.close;
    seedOfficialTrade(opened.db);
    opened.db.prepare(
      `INSERT INTO push_devices
         (id, user_id, platform, token, app_bundle, env, active, created_at, updated_at)
       VALUES (?, ?, 'apns', ?, 'trade.congress.ios', 'production', 1, ?, ?)`,
    ).run(
      'pdev_1',
      'user_1',
      liveToken,
      '2026-08-13T00:00:00.000Z',
      '2026-08-13T00:00:00.000Z',
    );

    const kv = new Map<string, string>();
    const env = {
      DB: opened.d1,
      CONFIG_KV: {
        async get(key: string) {
          return kv.get(key) ?? null;
        },
        async put(key: string, value: string) {
          kv.set(key, value);
        },
      },
    } as unknown as Env;

    const inspect = await inspectApnsFanoutDiagnostics(env);
    expect(inspect.queryOk).toBe(true);
    expect(inspect.queryError).toBeNull();
    expect(inspect.activeDevices).toBe(1);

    const calls: ApnsHttpRequest[] = [];
    const result = await fanOutApnsProductEvents(env, {
      loadConfig: () => config,
      now: new Date('2026-08-13T18:00:00.000Z'),
      readState: async () => ({
        lastTradeAt: '2026-08-13T16:00:00.000Z',
        lastReviewAt: '2026-08-13T16:00:00.000Z',
      }),
      writeState: async () => undefined,
      transport: async (req) => {
        calls.push(req);
        return { status: 200, body: '' };
      },
    });

    expect(result.skipped).toBeUndefined();
    expect(result.trades).toBe(1);
    expect(result.delivered).toBe(1);
    const title = (JSON.parse(calls[0]?.body ?? '{}') as { aps: { alert: { title: string } } }).aps.alert.title;
    expect(title).toBe('Nancy Pelosi bought NVDA');
    await expect(readApnsFanoutLastError(env)).resolves.toBeNull();
  });
});
