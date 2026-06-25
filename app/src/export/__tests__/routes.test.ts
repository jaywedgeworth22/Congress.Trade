/**
 * src/export/__tests__/routes.test.ts
 *
 * GET /api/export/bulk-snapshot + /file: auth gating (INGEST_TOKEN), input
 * validation (format, table, date, future-date), the cron-manifest path, inline
 * generation for today when no manifest exists yet, the missing-past-date 404,
 * and the token-gated streaming download (resolved through the manifest's
 * run-scoped object key).
 */

import { describe, it, expect } from 'vitest';
import { buildExportRouter } from '../routes';
import { manifestObjectKey, snapshotObjectKey } from '../snapshot';

const app = buildExportRouter();
const TOKEN = 'ingest-secret';
const RUN = 'run-1';

const decode = (v: unknown): string =>
  typeof v === 'string' ? v : new TextDecoder().decode(v as Uint8Array);

/** In-memory D1 paging fake (same shape as snapshot.test). */
function fakeDb(data: Record<string, Array<Record<string, unknown>>> = {}) {
  function makeStmt(sql: string) {
    const stmt = {
      bind: () => stmt,
      async all<T>() {
        const m = /FROM (\w+) .*LIMIT (\d+) OFFSET (\d+)/.exec(sql);
        if (!m) return { results: [] as T[] };
        const [, table, limit, offset] = m;
        const rows = (data[table] ?? []).slice(Number(offset), Number(offset) + Number(limit));
        return { results: rows as unknown as T[] };
      },
    };
    return stmt;
  }
  return { prepare: (sql: string) => makeStmt(sql) };
}

function fakeR2(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    store,
    async put(key: string, value: unknown) { store.set(key, decode(value)); },
    async get(key: string) {
      if (!store.has(key)) return null;
      const v = store.get(key) as string;
      return { body: v, async text() { return v; }, async json() { return JSON.parse(v); } };
    },
    async createMultipartUpload(key: string) {
      const parts: string[] = [];
      return {
        async uploadPart(n: number, value: unknown) { parts[n - 1] = decode(value); return { partNumber: n, etag: `e${n}` }; },
        async complete() { store.set(key, parts.join('')); },
        async abort() {},
      };
    },
  };
}

function req(path: string, env: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return app.request(path, { method: 'GET', headers }, env as never);
}

function baseEnv(extra: Record<string, unknown> = {}) {
  return { INGEST_TOKEN: TOKEN, DB: fakeDb(), RAW_FILES: fakeR2(), ...extra };
}

const TODAY = new Date().toISOString().slice(0, 10);

function manifestSeed(date: string) {
  return {
    [manifestObjectKey(date)]: JSON.stringify({
      generatedAt: '2026-06-25T04:00:00.000Z',
      snapshotDate: date,
      runId: RUN,
      format: 'ndjson',
      tables: {
        price_eod: { objectKey: snapshotObjectKey(date, RUN, 'price_eod'), rowCount: 3 },
        spx_eod: { objectKey: snapshotObjectKey(date, RUN, 'spx_eod'), rowCount: 1 },
        securities_ref: { objectKey: snapshotObjectKey(date, RUN, 'securities_ref'), rowCount: 2 },
        fundamentals_eod: { objectKey: snapshotObjectKey(date, RUN, 'fundamentals_eod'), rowCount: 0 },
        analyst_consensus: { objectKey: snapshotObjectKey(date, RUN, 'analyst_consensus'), rowCount: 0 },
      },
      schema: { price_eod: ['ticker', 'date', 'close', 'volume'], spx_eod: ['date', 'close'] },
    }),
  };
}

describe('GET /api/export/bulk-snapshot — auth', () => {
  it('401 without a token', async () => {
    expect((await req('/bulk-snapshot', baseEnv())).status).toBe(401);
  });
  it('401 with the wrong token', async () => {
    expect((await req('/bulk-snapshot', baseEnv(), 'nope')).status).toBe(401);
  });
  it('401 when INGEST_TOKEN is unset (closed by default)', async () => {
    expect((await req('/bulk-snapshot', { DB: fakeDb(), RAW_FILES: fakeR2() }, TOKEN)).status).toBe(401);
  });
});

describe('GET /api/export/bulk-snapshot — validation', () => {
  it('400 on an unsupported format', async () => {
    expect((await req('/bulk-snapshot?format=csv', baseEnv(), TOKEN)).status).toBe(400);
  });
  it('400 on an unknown table', async () => {
    expect((await req('/bulk-snapshot?tables=price_eod,bogus', baseEnv(), TOKEN)).status).toBe(400);
  });
  it('400 on a malformed date', async () => {
    expect((await req('/bulk-snapshot?date=2026-6-1', baseEnv(), TOKEN)).status).toBe(400);
  });
  it('400 on a future date', async () => {
    expect((await req('/bulk-snapshot?date=2099-01-01', baseEnv(), TOKEN)).status).toBe(400);
  });
});

describe('GET /api/export/bulk-snapshot — manifest', () => {
  it('returns the stored manifest with per-table downloadPath', async () => {
    const env = baseEnv({ RAW_FILES: fakeR2(manifestSeed('2026-06-24')) });
    const res = await req('/bulk-snapshot?date=2026-06-24', env, TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { snapshotDate: string; tables: Record<string, { downloadPath: string; rowCount: number }> };
    expect(body.snapshotDate).toBe('2026-06-24');
    expect(body.tables.price_eod.downloadPath).toBe('/api/export/bulk-snapshot/file?date=2026-06-24&table=price_eod');
    expect(body.tables.price_eod.rowCount).toBe(3);
  });

  it('narrows to the requested ?tables= subset', async () => {
    const env = baseEnv({ RAW_FILES: fakeR2(manifestSeed('2026-06-24')) });
    const res = await req('/bulk-snapshot?date=2026-06-24&tables=spx_eod', env, TOKEN);
    const body = (await res.json()) as { tables: Record<string, unknown> };
    expect(Object.keys(body.tables)).toEqual(['spx_eod']);
  });

  it('404 when a past date has no manifest', async () => {
    expect((await req('/bulk-snapshot?date=2020-01-01', baseEnv(), TOKEN)).status).toBe(404);
  });

  it('generates today inline when no manifest exists yet', async () => {
    const db = fakeDb({
      price_eod: [{ ticker: 'AAPL', date: TODAY, close: 200, volume: 10 }],
      spx_eod: [], securities_ref: [], fundamentals_eod: [], analyst_consensus: [],
    });
    const r2 = fakeR2();
    const res = await req('/bulk-snapshot', { INGEST_TOKEN: TOKEN, DB: db, RAW_FILES: r2 }, TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { snapshotDate: string; tables: Record<string, { rowCount: number }> };
    expect(body.snapshotDate).toBe(TODAY);
    expect(body.tables.price_eod.rowCount).toBe(1);
    expect(r2.store.has(manifestObjectKey(TODAY))).toBe(true);
  });
});

describe('GET /api/export/bulk-snapshot/file — download', () => {
  it('streams the NDJSON object resolved through the manifest', async () => {
    const seed = manifestSeed('2026-06-24');
    seed[snapshotObjectKey('2026-06-24', RUN, 'price_eod')] = '{"ticker":"AAPL"}\n';
    const env = baseEnv({ RAW_FILES: fakeR2(seed) });
    const res = await req('/bulk-snapshot/file?date=2026-06-24&table=price_eod', env, TOKEN);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    expect(await res.text()).toBe('{"ticker":"AAPL"}\n');
  });
  it('401 without a token', async () => {
    expect((await req('/bulk-snapshot/file?date=2026-06-24&table=price_eod', baseEnv())).status).toBe(401);
  });
  it('400 on an unknown table', async () => {
    expect((await req('/bulk-snapshot/file?date=2026-06-24&table=bogus', baseEnv(), TOKEN)).status).toBe(400);
  });
  it('404 when the manifest (and thus the file) is absent', async () => {
    expect((await req('/bulk-snapshot/file?date=2026-06-24&table=price_eod', baseEnv(), TOKEN)).status).toBe(404);
  });
});
