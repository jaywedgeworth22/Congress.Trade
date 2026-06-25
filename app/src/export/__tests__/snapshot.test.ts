/**
 * src/export/__tests__/snapshot.test.ts
 *
 * Unit tests for the bulk snapshot writer with in-memory D1 + R2 fakes. Assert:
 * five NDJSON objects + a manifest are written, the manifest lands LAST (so a
 * partial run is invisible), row counts + NDJSON line counts match the seed, the
 * paged read walks the table in 10k chunks, and a >5 MiB table takes the R2
 * multipart path while small tables use a single PUT.
 */

import { describe, it, expect } from 'vitest';
import type { Env } from '../../shared/types';
import {
  runBulkSnapshot,
  readManifest,
  manifestObjectKey,
  snapshotObjectKey,
  SNAPSHOT_TABLES,
} from '../snapshot';

/** In-memory D1: pages `SELECT * FROM <table> ... LIMIT n OFFSET m` from seeded arrays. */
function fakeDb(data: Record<string, Array<Record<string, unknown>>>) {
  const pageSql: string[] = [];
  function makeStmt(sql: string) {
    const stmt = {
      bind: () => stmt,
      async all<T>() {
        pageSql.push(sql);
        const m = /FROM (\w+) .*LIMIT (\d+) OFFSET (\d+)/.exec(sql);
        if (!m) return { results: [] as T[] };
        const [, table, limit, offset] = m;
        const rows = (data[table] ?? []).slice(Number(offset), Number(offset) + Number(limit));
        return { results: rows as unknown as T[] };
      },
    };
    return stmt;
  }
  return { db: { prepare: (sql: string) => makeStmt(sql) }, pageSql };
}

/** In-memory R2: records write order + whether each object came via multipart. */
function fakeR2() {
  const store = new Map<string, string>();
  const writeOrder: string[] = [];
  const multipartKeys = new Set<string>();
  const r2 = {
    store,
    writeOrder,
    multipartKeys,
    async put(key: string, value: string) {
      store.set(key, value);
      writeOrder.push(key);
    },
    async get(key: string) {
      if (!store.has(key)) return null;
      const v = store.get(key) as string;
      return { body: v, async text() { return v; }, async json() { return JSON.parse(v); } };
    },
    async createMultipartUpload(key: string) {
      const parts: string[] = [];
      return {
        async uploadPart(partNumber: number, value: string) {
          parts[partNumber - 1] = value;
          return { partNumber, etag: `etag-${partNumber}` };
        },
        async complete() {
          store.set(key, parts.join(''));
          writeOrder.push(key);
          multipartKeys.add(key);
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

const NOW = new Date('2026-06-25T04:01:00.000Z');

describe('runBulkSnapshot', () => {
  it('writes five NDJSON tables + a manifest, with the manifest LAST', async () => {
    const { db } = fakeDb({
      price_eod: [
        { ticker: 'AAPL', date: '2026-06-24', close: 200, volume: 1000 },
        { ticker: 'MSFT', date: '2026-06-24', close: 400, volume: 2000 },
      ],
      spx_eod: [{ date: '2026-06-24', close: 5000 }],
      securities_ref: [{ ticker: 'AAPL', company_name: 'Apple', enrichment_error: null }],
      fundamentals_eod: [{ ticker: 'AAPL', date: '2026-06-24', pe_ratio: 30 }],
      analyst_consensus: [{ ticker: 'AAPL', date: '2026-06-24', rating: 'Buy' }],
    });
    const r2 = fakeR2();
    const manifest = await runBulkSnapshot(envWith(db, r2), '2026-06-25', NOW);

    // One object per table + the manifest, six writes total.
    expect(r2.store.size).toBe(SNAPSHOT_TABLES.length + 1);
    for (const t of SNAPSHOT_TABLES) {
      expect(r2.store.has(snapshotObjectKey('2026-06-25', t.name))).toBe(true);
    }
    // Manifest is the FINAL write so a partial run leaves no manifest.
    expect(r2.writeOrder[r2.writeOrder.length - 1]).toBe(manifestObjectKey('2026-06-25'));

    expect(manifest.snapshotDate).toBe('2026-06-25');
    expect(manifest.generatedAt).toBe(NOW.toISOString());
    expect(manifest.format).toBe('ndjson');
    expect(manifest.tables.price_eod.rowCount).toBe(2);
    expect(manifest.tables.spx_eod.rowCount).toBe(1);
    expect(manifest.schema.price_eod).toEqual(['ticker', 'date', 'close', 'volume']);
  });

  it('emits one JSON object per row (valid NDJSON, line count == rowCount)', async () => {
    const { db } = fakeDb({
      price_eod: [
        { ticker: 'AAPL', date: '2026-06-24', close: 200, volume: null },
        { ticker: 'MSFT', date: '2026-06-24', close: 400, volume: 2000 },
      ],
      spx_eod: [],
      securities_ref: [],
      fundamentals_eod: [],
      analyst_consensus: [],
    });
    const r2 = fakeR2();
    await runBulkSnapshot(envWith(db, r2), '2026-06-25', NOW);

    const ndjson = r2.store.get(snapshotObjectKey('2026-06-25', 'price_eod')) as string;
    const lines = ndjson.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first).toEqual({ ticker: 'AAPL', date: '2026-06-24', close: 200, volume: null });
    // An empty table is a single empty PUT, not a multipart upload.
    expect(r2.store.get(snapshotObjectKey('2026-06-25', 'spx_eod'))).toBe('');
  });

  it('pages a multi-page table in 10k chunks (line count preserved across pages)', async () => {
    const rows = Array.from({ length: 25_001 }, (_, i) => ({
      ticker: 'T' + (i % 10),
      date: '2026-06-24',
      close: i,
      volume: i,
    }));
    const { db, pageSql } = fakeDb({
      price_eod: rows,
      spx_eod: [],
      securities_ref: [],
      fundamentals_eod: [],
      analyst_consensus: [],
    });
    const r2 = fakeR2();
    const manifest = await runBulkSnapshot(envWith(db, r2), '2026-06-25', NOW);

    expect(manifest.tables.price_eod.rowCount).toBe(25_001);
    const lines = (r2.store.get(snapshotObjectKey('2026-06-25', 'price_eod')) as string)
      .split('\n')
      .filter(Boolean);
    expect(lines).toHaveLength(25_001);
    // 25,001 rows / 10k page = pages at offset 0, 10000, 20000 (3rd returns 5001 < 10k, loop stops).
    const priceOffsets = pageSql
      .filter((s) => s.includes('FROM price_eod'))
      .map((s) => Number(/OFFSET (\d+)/.exec(s)![1]));
    expect(priceOffsets).toEqual([0, 10_000, 20_000]);
  });

  it('takes the R2 multipart path once a table exceeds the 5 MiB part threshold', async () => {
    // ~56 bytes/line * 110k ≈ 6.1 MB > 5 MiB → at least one part flushed mid-stream.
    const rows = Array.from({ length: 110_000 }, () => ({
      ticker: 'AAAA',
      date: '2026-01-01',
      close: 1,
      volume: 1,
    }));
    const { db } = fakeDb({
      price_eod: rows,
      spx_eod: [{ date: '2026-06-24', close: 5000 }],
      securities_ref: [],
      fundamentals_eod: [],
      analyst_consensus: [],
    });
    const r2 = fakeR2();
    const manifest = await runBulkSnapshot(envWith(db, r2), '2026-06-25', NOW);

    expect(manifest.tables.price_eod.rowCount).toBe(110_000);
    const key = snapshotObjectKey('2026-06-25', 'price_eod');
    expect(r2.multipartKeys.has(key)).toBe(true); // big table → multipart
    expect((r2.store.get(key) as string).split('\n').filter(Boolean)).toHaveLength(110_000);
    // The small spx table stays a single PUT.
    expect(r2.multipartKeys.has(snapshotObjectKey('2026-06-25', 'spx_eod'))).toBe(false);
  });

  it('readManifest round-trips the written manifest', async () => {
    const { db } = fakeDb({
      price_eod: [], spx_eod: [], securities_ref: [], fundamentals_eod: [], analyst_consensus: [],
    });
    const r2 = fakeR2();
    await runBulkSnapshot(envWith(db, r2), '2026-06-25', NOW);
    const read = await readManifest(envWith(db, r2), '2026-06-25');
    expect(read?.snapshotDate).toBe('2026-06-25');
    expect(await readManifest(envWith(db, r2), '2099-01-01')).toBeNull();
  });
});
