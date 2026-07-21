import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env, Filing, ParsedTx } from '../../shared/types.ts';

const mocks = vi.hoisted(() => ({
  extractParsed: vi.fn(),
  recomputeTransactions: vi.fn(),
  normalize: vi.fn(),
}));

vi.mock('../../extraction/orchestrator', () => ({
  extractParsed: mocks.extractParsed,
}));

vi.mock('../../extraction/normalizer', async () => {
  const actual = await vi.importActual<typeof import('../../extraction/normalizer')>(
    '../../extraction/normalizer',
  );
  return {
    ...actual,
    normalize: mocks.normalize,
    recomputeTransactions: mocks.recomputeTransactions,
  };
});

import { buildAdminRouter } from '../routes.ts';

const app = buildAdminRouter();

function filing(): Filing {
  return {
    docId: 'H-1',
    chamber: 'house',
    filerId: 'house-ca01-test-member',
    filingType: 'P',
    filedDate: '2026-06-30',
    sourceUrl: 'https://example.test/H-1.pdf',
    rawObjectKey: 'raw/H-1.pdf',
    ingestStatus: 'needs_review',
    docKind: 'scanned_pdf',
    extractor: 'visionLlm',
    modelVersion: 'test-model',
    confidence: null,
    firstSeenAt: '2026-06-30T00:00:00.000Z',
    sourceUpdatedAt: null,
    error: null,
  };
}

function parsedTx(): ParsedTx {
  return {
    txDate: '2026-06-29',
    owner: 'self',
    assetName: 'Header-contaminated row',
    ticker: 'AAPL',
    assetType: 'Stock',
    txType: 'P',
    amountMin: 1001,
    amountMax: 15000,
    isOption: false,
    capGainsOver200: false,
    rawText: 'row',
    confidence: 0.99,
  };
}

function fakeDb() {
  return {
    prepare(sql: string) {
      return {
        params: [] as unknown[],
        bind(...params: unknown[]) {
          this.params = params;
          return this;
        },
        async all<T>() {
          if (/SELECT doc_id FROM filings/i.test(sql)) {
            return { results: [{ doc_id: 'H-1' }] as T[] };
          }
          if (/SELECT id FROM transactions/i.test(sql)) {
            return { results: [] as T[] };
          }
          return { results: [] as T[] };
        },
        async first<T>() {
          return null as T | null;
        },
        async run() {
          return { success: true, meta: { changes: 1 } };
        },
      };
    },
  } as unknown as D1Database;
}

describe('admin /reprocess hard failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps high-confidence bad_asset_name rows in review', async () => {
    mocks.extractParsed.mockResolvedValue({
      filing: filing(),
      transactions: [parsedTx()],
      extractor: 'visionLlm',
      modelVersion: 'test-model',
    });
    mocks.recomputeTransactions.mockResolvedValue([
      {
        tx: { confidence: 0.99 },
        flags: ['bad_asset_name'],
      },
    ]);

    const res = await app.request(
      '/reprocess',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ chamber: 'house', limit: 1 }),
      },
      {
        ADMIN_TOKEN: 'admin-secret',
        DB: fakeDb(),
      } as unknown as Env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      filingsPromoted: number;
      rowsPromoted: number;
      filingsStillInReview: number;
    };
    expect(body.filingsPromoted).toBe(0);
    expect(body.rowsPromoted).toBe(0);
    expect(body.filingsStillInReview).toBe(1);
    expect(mocks.normalize).not.toHaveBeenCalled();
  });

  it('refreshes est_value when reprocessing an existing transaction in place', async () => {
    mocks.extractParsed.mockResolvedValue({
      filing: filing(),
      transactions: [parsedTx()],
      extractor: 'visionLlm',
      modelVersion: 'test-model',
    });
    mocks.recomputeTransactions.mockResolvedValue([{
      tx: { confidence: 0.93, amountMin: 1001, amountMax: 15000, ticker: 'AAPL' },
      flags: [],
    }]);
    const writes: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        return {
          params: [] as unknown[],
          bind(...params: unknown[]) { this.params = params; return this; },
          async all<T>() {
            if (/SELECT doc_id FROM filings/i.test(sql)) return { results: [{ doc_id: 'H-1' }] as T[] };
            if (/SELECT id FROM transactions/i.test(sql)) return { results: [{ id: 'tx-existing' }] as T[] };
            return { results: [] as T[] };
          },
          async first<T>() { return null as T | null; },
          async run() {
            writes.push({ sql, params: this.params });
            return { success: true, meta: { changes: 1 } };
          },
        };
      },
    } as unknown as D1Database;

    const res = await app.request(
      '/reprocess',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ chamber: 'house', limit: 1 }),
      },
      { ADMIN_TOKEN: 'admin-secret', DB: db } as unknown as Env,
    );

    expect(res.status).toBe(200);
    const txUpdate = writes.find(({ sql }) => /UPDATE transactions/i.test(sql));
    expect(txUpdate?.sql).toContain('est_value = ?');
    expect(txUpdate?.params).toEqual([0.93, 1001, 15000, 8000.5, 'AAPL', 'tx-existing']);
  });
});
