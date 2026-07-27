/**
 * src/export/__tests__/snapshot.test.ts
 *
 * Unit tests for the bulk snapshot writer with in-memory D1 + R2 fakes. Assert:
 * five NDJSON objects + a manifest are written, the manifest lands LAST (so a
 * partial run is invisible), row counts + NDJSON line counts match the seed, the
 * paged read walks the table in 10k chunks, files live under a run-scoped prefix,
 * and a multi-part table uploads EQUAL-sized non-final parts (R2's requirement).
 */

import { describe, it, expect } from 'vitest';
import type { Env } from '../../shared/types.ts';
import {
  runBulkSnapshot,
  readManifest,
  manifestObjectKey,
  snapshotObjectKey,
  SNAPSHOT_TABLES,
  SNAPSHOT_SCHEMA,
} from '../snapshot.ts';

const RUN = 'run-fixed-1';
const NOW = new Date('2026-06-25T04:01:00.000Z');

const decode = (v: unknown): string =>
  typeof v === 'string' ? v : new TextDecoder().decode(v as Uint8Array);
const byteLen = (v: unknown): number =>
  typeof v === 'string' ? new TextEncoder().encode(v).length : (v as ArrayBuffer).byteLength;

/** In-memory D1: pages `SELECT * FROM <table> ... LIMIT n OFFSET m` from seeded arrays. */
function fakeDb(data: Record<string, Array<Record<string, unknown>>>) {
  const pageSql: string[] = [];
  const read = new Map<string, number>();
  function makeStmt(sql: string) {
    const stmt = {
      bind: () => stmt,
      async all<T>() {
        pageSql.push(sql);
        const m = /FROM (\w+)/.exec(sql);
        const lm = /LIMIT (\d+)/.exec(sql);
        if (!m || !lm) return { results: [] as T[] };
        const table = m[1];
        const start = read.get(table) ?? 0;
        const rows = (data[table] ?? []).slice(start, start + Number(lm[1]));
        read.set(table, start + rows.length);
        return { results: rows as unknown as T[] };
      },
    };
    return stmt;
  }
  return { db: { prepare: (sql: string) => makeStmt(sql) }, pageSql };
}

/** In-memory R2: records write order, multipart part sizes, and stored bodies. */
function fakeR2() {
  const store = new Map<string, string>();
  const writeOrder: string[] = [];
  const partSizes = new Map<string, number[]>();
  const r2 = {
    store,
    writeOrder,
    partSizes,
    async put(key: string, value: unknown) {
      store.set(key, decode(value));
      writeOrder.push(key);
    },
    async get(key: string) {
      if (!store.has(key)) return null;
      const v = store.get(key) as string;
      return { body: v, async text() { return v; }, async json() { return JSON.parse(v); } };
    },
    async createMultipartUpload(key: string) {
      const chunks: string[] = [];
      const sizes: number[] = [];
      return {
        async uploadPart(partNumber: number, value: unknown) {
          chunks[partNumber - 1] = decode(value);
          sizes[partNumber - 1] = byteLen(value);
          return { partNumber, etag: `etag-${partNumber}` };
        },
        async complete() {
          store.set(key, chunks.join(''));
          writeOrder.push(key);
          partSizes.set(key, sizes);
        },
        async abort() { /* no-op */ },
      };
    },
  };
  return r2;
}

function envWith(db: unknown, r2: unknown): Env {
  return { DB: db, RAW_FILES: r2 } as unknown as Env;
}

describe('runBulkSnapshot', () => {
  it('writes five run-scoped NDJSON tables + a manifest, with the manifest LAST', async () => {
    const { db } = fakeDb({
      price_eod: [
        { ticker: 'AAPL', date: '2026-06-24', close: 200, volume: 1000 },
        { ticker: 'MSFT', date: '2026-06-24', close: 400, volume: 2000 },
      ],
      spx_eod: [{ date: '2026-06-24', close: 5000 }],
      securities_ref: [{ ticker: 'AAPL', company_name: 'Apple', shares_outstanding: 15e9 }],
      fundamentals_eod: [{ ticker: 'AAPL', date: '2026-06-24', pe_ratio: 30 }],
      analyst_consensus: [{ ticker: 'AAPL', date: '2026-06-24', rating: 'Buy' }],
    });
    const r2 = fakeR2();
    const manifest = await runBulkSnapshot(envWith(db, r2), '2026-06-25', NOW, RUN);

    expect(r2.store.size).toBe(SNAPSHOT_TABLES.length + 1);
    for (const t of SNAPSHOT_TABLES) {
      const key = snapshotObjectKey('2026-06-25', RUN, t.name);
      expect(key).toContain(`bulk/2026-06-25/runs/${RUN}/`);
      expect(r2.store.has(key)).toBe(true);
      expect(manifest.tables[t.name].objectKey).toBe(key); // manifest points at this run's files
    }
    // Manifest is the FINAL write so a partial run leaves no manifest.
    expect(r2.writeOrder[r2.writeOrder.length - 1]).toBe(manifestObjectKey('2026-06-25'));
    expect(manifest.runId).toBe(RUN);
    expect(manifest.generatedAt).toBe(NOW.toISOString());
    expect(manifest.tables.price_eod.rowCount).toBe(2);
    // shares_outstanding is now advertised in the securities_ref schema.
    expect(SNAPSHOT_SCHEMA.securities_ref).toContain('shares_outstanding');
    expect(manifest.schema.securities_ref).toContain('shares_outstanding');
  });

  it('emits one JSON object per row (valid NDJSON, line count == rowCount)', async () => {
    const { db } = fakeDb({
      price_eod: [
        { ticker: 'AAPL', date: '2026-06-24', close: 200, volume: null },
        { ticker: 'MSFT', date: '2026-06-24', close: 400, volume: 2000 },
      ],
      spx_eod: [], securities_ref: [], fundamentals_eod: [], analyst_consensus: [],
    });
    const r2 = fakeR2();
    await runBulkSnapshot(envWith(db, r2), '2026-06-25', NOW, RUN);

    const ndjson = r2.store.get(snapshotObjectKey('2026-06-25', RUN, 'price_eod')) as string;
    const lines = ndjson.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ ticker: 'AAPL', date: '2026-06-24', close: 200, volume: null });
    // An empty table is a single empty PUT, not a multipart upload.
    expect(r2.store.get(snapshotObjectKey('2026-06-25', RUN, 'spx_eod'))).toBe('');
  });

  it('pages a multi-page table via KEYSET (no OFFSET; cursor on later pages)', async () => {
    const rows = Array.from({ length: 25_001 }, (_, i) => ({
      ticker: 'T' + String(i).padStart(6, '0'),
      date: '2026-06-24',
      close: i,
      volume: i,
    }));
    const { db, pageSql } = fakeDb({
      price_eod: rows, spx_eod: [], securities_ref: [], fundamentals_eod: [], analyst_consensus: [],
    });
    const r2 = fakeR2();
    const manifest = await runBulkSnapshot(envWith(db, r2), '2026-06-25', NOW, RUN);

    expect(manifest.tables.price_eod.rowCount).toBe(25_001);
    const lines = (r2.store.get(snapshotObjectKey('2026-06-25', RUN, 'price_eod')) as string).split('\n').filter(Boolean);
    expect(lines).toHaveLength(25_001);
    const pricePages = pageSql.filter((s) => s.includes('FROM price_eod'));
    expect(pricePages).toHaveLength(3); // 10k + 10k + 5001
    expect(pricePages.every((s) => !s.includes('OFFSET'))).toBe(true);
    expect(pricePages[0]).toContain('ORDER BY ticker ASC, date ASC');
    expect(pricePages[0]).not.toContain('WHERE'); // first page has no cursor
    // Later pages carry the keyset cursor predicate.
    expect(pricePages[1]).toContain('(ticker, date) > (?, ?)');
  });

  it('uploads EQUAL-sized non-final multipart parts (R2 requirement) for a big table', async () => {
    // ~660 bytes/line * 30k ≈ 19.8 MB → two full 8 MiB parts + a smaller final part.
    const pad = 'x'.repeat(600);
    const rows = Array.from({ length: 30_000 }, () => ({ ticker: 'AAAA', date: '2026-01-01', close: 1, volume: 1, pad }));
    const { db } = fakeDb({
      price_eod: rows, spx_eod: [{ date: '2026-06-24', close: 5000 }], securities_ref: [], fundamentals_eod: [], analyst_consensus: [],
    });
    const r2 = fakeR2();
    const manifest = await runBulkSnapshot(envWith(db, r2), '2026-06-25', NOW, RUN);

    expect(manifest.tables.price_eod.rowCount).toBe(30_000);
    const key = snapshotObjectKey('2026-06-25', RUN, 'price_eod');
    const sizes = r2.partSizes.get(key)!;
    expect(sizes.length).toBeGreaterThanOrEqual(3); // ≥2 full parts + final remainder
    const nonFinal = sizes.slice(0, -1);
    // Every non-final part is the SAME size and >= R2's 5 MiB minimum.
    expect(new Set(nonFinal).size).toBe(1);
    expect(nonFinal[0]).toBeGreaterThanOrEqual(5 * 1024 * 1024);
    expect(sizes[sizes.length - 1]).toBeLessThanOrEqual(nonFinal[0]);
    // Round-trips: line count still equals the row count after reassembly.
    expect((r2.store.get(key) as string).split('\n').filter(Boolean)).toHaveLength(30_000);
    // The small spx table stays a single PUT (no recorded parts).
    expect(r2.partSizes.has(snapshotObjectKey('2026-06-25', RUN, 'spx_eod'))).toBe(false);
  });

  it('aborts the multipart upload (no orphaned parts) when a part fails mid-stream', async () => {
    const pad = 'x'.repeat(600);
    const rows = Array.from({ length: 30_000 }, () => ({ ticker: 'AAAA', date: '2026-01-01', close: 1, volume: 1, pad }));
    const { db } = fakeDb({
      price_eod: rows, spx_eod: [], securities_ref: [], fundamentals_eod: [], analyst_consensus: [],
    });
    let aborted = false;
    const failingR2 = {
      async put() { /* unused for the big table */ },
      async get() { return null; },
      async createMultipartUpload() {
        let calls = 0;
        return {
          async uploadPart() {
            calls += 1;
            if (calls >= 2) throw new Error('R2 uploadPart failed');
            return { partNumber: calls, etag: 'e' };
          },
          async complete() { /* never reached */ },
          async abort() { aborted = true; },
        };
      },
    };
    await expect(runBulkSnapshot(envWith(db, failingR2), '2026-06-25', NOW, RUN)).rejects.toThrow('uploadPart failed');
    expect(aborted).toBe(true);
  });

  it('readManifest round-trips the written manifest', async () => {
    const { db } = fakeDb({ price_eod: [], spx_eod: [], securities_ref: [], fundamentals_eod: [], analyst_consensus: [] });
    const r2 = fakeR2();
    await runBulkSnapshot(envWith(db, r2), '2026-06-25', NOW, RUN);
    const read = await readManifest(envWith(db, r2), '2026-06-25');
    expect(read?.snapshotDate).toBe('2026-06-25');
    expect(read?.runId).toBe(RUN);
    expect(await readManifest(envWith(db, r2), '2099-01-01')).toBeNull();
  });
});
