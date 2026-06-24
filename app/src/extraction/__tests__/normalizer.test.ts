import { describe, it, expect } from 'vitest';
import { normalize, CONFIDENCE_THRESHOLD } from '../normalizer';
import type { Env, Filing, ParsedTx } from '../../shared/types';

// ---------------------------------------------------------------------------
// Minimal in-memory D1 + Queue fakes. We only need to satisfy the prepared-
// statement surface the normalizer touches (prepare -> bind -> all/run/first),
// and capture which writes happened.
// ---------------------------------------------------------------------------

interface Captured {
  insertedTx: unknown[][];
  reviewRows: unknown[][];
  filingUpdates: unknown[][];
  enqueued: Array<{ type: string; txId: string }>;
}

function makeEnv(securities: Array<{ ticker: string; name: string | null; aliases: string | null }>) {
  const cap: Captured = { insertedTx: [], reviewRows: [], filingUpdates: [], enqueued: [] };
  const insertedRowKeys = new Set<string>();

  const prepare = (sql: string) => {
    const stmt = {
      _params: [] as unknown[],
      bind(...params: unknown[]) {
        this._params = params;
        return this;
      },
      async all<T>() {
        if (/FROM securities_master/i.test(sql)) {
          return { results: securities as unknown as T[] };
        }
        return { results: [] as T[] };
      },
      async first<T>() {
        return null as T | null;
      },
      async run() {
        let changes = 1;
        if (/INSERT(?: OR IGNORE)? INTO transactions/i.test(sql)) {
          const rowKey = String(this._params[14] ?? '');
          if (insertedRowKeys.has(rowKey)) {
            changes = 0;
          } else {
            insertedRowKeys.add(rowKey);
            cap.insertedTx.push(this._params);
          }
        } else if (/INSERT INTO review_queue/i.test(sql)) cap.reviewRows.push(this._params);
        else if (/UPDATE filings/i.test(sql)) cap.filingUpdates.push(this._params);
        return { success: true, meta: { changes } } as unknown;
      },
    };
    return stmt;
  };

  const env = {
    DB: { prepare } as unknown as D1Database,
    DELIVERY_QUEUE: {
      async send(msg: { type: string; txId: string }) {
        cap.enqueued.push(msg);
      },
    } as unknown as Env['DELIVERY_QUEUE'],
  } as unknown as Env;

  return { env, cap };
}

const filing = (over: Partial<Filing> = {}): Filing => ({
  docId: 'doc1',
  chamber: 'senate',
  filerId: 'F1',
  filingType: 'P',
  filedDate: '2024-07-01',
  sourceUrl: 'https://x',
  rawObjectKey: 'raw/senate/doc1.html',
  ingestStatus: 'extracted',
  docKind: 'senate_html',
  extractor: 'senateHtml',
  modelVersion: null,
  confidence: null,
  firstSeenAt: '2024-07-01T00:00:00.000Z',
  sourceUpdatedAt: null,
  error: null,
  ...over,
});

const tx = (over: Partial<ParsedTx> = {}): ParsedTx => ({
  txDate: '2024-06-14',
  owner: 'self',
  assetName: 'Apple Inc.',
  ticker: 'AAPL',
  assetType: 'Stock',
  txType: 'P',
  amountMin: 1001,
  amountMax: 15000,
  isOption: false,
  capGainsOver200: false,
  rawText: 'AAPL Apple Inc P $1,001 - $15,000',
  confidence: 0.97,
  ...over,
});

describe('normalize', () => {
  it('publishes high-confidence, resolved, valid rows', async () => {
    const { env, cap } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '["Apple"]' }]);
    const result = await normalize(env, filing(), [tx()]);

    expect(result.needsReview).toBe(false);
    expect(result.minConfidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].ticker).toBe('AAPL');
    expect(result.transactions[0].source).toBe('primary');

    // Persisted + delivery fan-out happened; no review row.
    expect(cap.insertedTx).toHaveLength(1);
    expect(cap.insertedTx[0][20]).toEqual(expect.stringMatching(/^v1:primary:0:/));
    expect(cap.reviewRows).toHaveLength(0);
    expect(cap.enqueued).toEqual([{ type: 'delivery.dispatch', txId: result.transactions[0].id }]);
    // filings updated (metadata + persisted status).
    expect(cap.filingUpdates.length).toBeGreaterThanOrEqual(2);
  });

  it('does not insert or enqueue duplicates when the same filing is normalized twice', async () => {
    const { env, cap } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '["Apple"]' }]);
    const first = await normalize(env, filing(), [tx()]);
    const second = await normalize(env, filing(), [tx()]);

    expect(first.needsReview).toBe(false);
    expect(second.needsReview).toBe(false);
    expect(cap.insertedTx).toHaveLength(1);
    expect(cap.enqueued).toHaveLength(1);
    expect(cap.enqueued[0]).toEqual({ type: 'delivery.dispatch', txId: first.transactions[0].id });
  });

  it('resolves ticker via alias when raw ticker is missing', async () => {
    const { env } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '["apple inc."]' }]);
    const result = await normalize(env, filing(), [tx({ ticker: null })]);
    expect(result.transactions[0].ticker).toBe('AAPL');
    expect(result.needsReview).toBe(false);
  });

  it('routes to review when ticker is unresolved (confidence penalty pushes below threshold)', async () => {
    const { env, cap } = makeEnv([]); // empty securities_master => unresolved
    const result = await normalize(
      env,
      filing(),
      [tx({ ticker: 'ZZZZ', assetName: 'Mystery Co' })],
      { extractor: 'visionLlm', modelVersion: 'gemini-test' },
    );

    // 0.97 * 0.85 (unresolved) = 0.8245 < 0.85 threshold.
    expect(result.minConfidence).toBeLessThan(CONFIDENCE_THRESHOLD);
    expect(result.needsReview).toBe(true);
    expect(cap.insertedTx).toHaveLength(0);
    expect(cap.reviewRows).toHaveLength(1);
    expect(cap.enqueued).toHaveLength(0);
    expect(String(cap.reviewRows[0][1])).toContain('unresolved_ticker');
    expect(JSON.parse(String(cap.reviewRows[0][2]))).toMatchObject({
      extractor: 'visionLlm',
      modelVersion: 'gemini-test',
    });
  });

  it('snaps a plausible non-canonical amount to the nearest bracket without penalty', async () => {
    const { env, cap } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '[]' }]);
    // 1200–14000 isn't an exact STOCK Act bracket but is a sane range -> snap, no penalty.
    const result = await normalize(env, filing(), [tx({ amountMin: 1200, amountMax: 14000 })]);
    expect(result.needsReview).toBe(false);
    expect(result.minConfidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
    expect(cap.insertedTx).toHaveLength(1);
  });

  it('routes to review when the amount is missing entirely', async () => {
    const { env, cap } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '[]' }]);
    const result = await normalize(env, filing(), [tx({ amountMin: null, amountMax: null })]);
    expect(result.needsReview).toBe(true);
    expect(cap.reviewRows).toHaveLength(1);
    expect(String(cap.reviewRows[0][1])).toContain('no_amount');
  });

  it('does not penalize a legitimately ticker-less asset (no ticker supplied)', async () => {
    const { env, cap } = makeEnv([]); // empty securities_master
    const result = await normalize(env, filing(), [
      tx({ ticker: null, assetName: 'US Treasury Bond 2.5% 2030' }),
    ]);
    expect(result.needsReview).toBe(false);
    expect(result.minConfidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
    expect(cap.insertedTx).toHaveLength(1);
  });

  it('flags a tx_date after the filing filed_date', async () => {
    const { env } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '[]' }]);
    const result = await normalize(env, filing({ filedDate: '2024-06-01' }), [
      tx({ txDate: '2024-06-14' }),
    ]);
    // 0.97 * 0.7 (future date) = 0.679 < threshold => review.
    expect(result.needsReview).toBe(true);
    expect(result.minConfidence).toBeLessThan(CONFIDENCE_THRESHOLD);
  });

  it('routes empty extraction to review', async () => {
    const { env, cap } = makeEnv([]);
    const result = await normalize(env, filing(), []);
    expect(result.needsReview).toBe(true);
    expect(result.minConfidence).toBe(0);
    expect(cap.reviewRows).toHaveLength(1);
    expect(String(cap.reviewRows[0][1])).toContain('no_transactions_extracted');
    expect(String(cap.reviewRows[0][1])).toContain('low_confidence');
  });
});
