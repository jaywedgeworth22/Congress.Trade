import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../shared/types.ts';
import type { ApnsHttpRequest } from '../../shared/apns.ts';
import { fanOutApnsProductEvents, officialTradeFanoutSql } from '../apnsFanout.ts';

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

describe('fanOutApnsProductEvents', () => {
  const config = {
    keyId: 'P4US7YTWH4',
    teamId: 'CC8UTF7ATG',
    bundleId: 'trade.congress.ios',
    privateKeyPem: pem,
  };

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

  it('joins filers on bioguide_id against a real SQLite schema (no f.id)', async () => {
    const sql = officialTradeFanoutSql(40);
    expect(sql).toMatch(/LEFT JOIN filers f ON f\.bioguide_id = t\.filer_id/);
    expect(sql).not.toMatch(/f\.id\s*=/);

    const sqlite = (await import('node:sqlite')) as {
      DatabaseSync: new (path: string) => {
        exec(s: string): void;
        prepare(s: string): { all: (...params: unknown[]) => Array<Record<string, unknown>> };
      };
    };
    const db = new sqlite.DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE filers (
        bioguide_id TEXT PRIMARY KEY,
        full_name TEXT,
        display_name TEXT
      );
      CREATE TABLE transactions (
        id TEXT PRIMARY KEY,
        ticker TEXT,
        tx_type TEXT,
        asset_name TEXT,
        created_at TEXT,
        filer_id TEXT,
        deprecated_at TEXT
      );
      CREATE TABLE delivery_outbox (tx_id TEXT);
      INSERT INTO filers (bioguide_id, full_name, display_name)
        VALUES ('P000197', 'Nancy Pelosi', 'Nancy Pelosi');
      INSERT INTO transactions (id, ticker, tx_type, asset_name, created_at, filer_id, deprecated_at)
        VALUES ('tx_1', 'NVDA', 'P', 'NVIDIA', '2026-08-13T17:30:00.000Z', 'P000197', NULL);
      INSERT INTO delivery_outbox (tx_id) VALUES ('tx_1');
    `);
    const rows = db.prepare(sql).all('2026-08-13T16:00:00.000Z');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.filer_name).toBe('Nancy Pelosi');
  });
});
