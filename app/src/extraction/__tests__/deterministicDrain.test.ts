import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  maybeRunDeterministicReviewDrain,
  sweepRejectedScannedForLocalVision,
} from '../deterministicDrain.ts';

const mocks = vi.hoisted(() => ({
  extractAndNormalize: vi.fn(),
  extractParsed: vi.fn(),
  normalize: vi.fn(),
  recordIngestionDecision: vi.fn(),
}));

vi.mock('../orchestrator.ts', () => ({
  extractAndNormalize: mocks.extractAndNormalize,
  extractParsed: mocks.extractParsed,
}));

vi.mock('../normalizer.ts', async () => {
  const actual = await vi.importActual<typeof import('../normalizer.ts')>('../normalizer.ts');
  return {
    ...actual,
    normalize: mocks.normalize,
  };
});

vi.mock('../../shared/ingestionDecisions.ts', () => ({
  recordIngestionDecision: mocks.recordIngestionDecision,
}));

function makeEnv(rows: Array<Record<string, unknown>>, opts: { liveTx?: number } = {}) {
  const queue: unknown[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        const bound: unknown[] = [];
        const stmt = {
          bind(...args: unknown[]) {
            bound.push(...args);
            return stmt;
          },
          async all() {
            if (/FROM review_queue/i.test(sql) || /FROM filings f/i.test(sql) && /review_queue/i.test(sql)) {
              return { results: rows };
            }
            if (/COUNT\(\*\)/i.test(sql)) {
              return { results: [{ n: opts.liveTx ?? 0 }] };
            }
            if (/local_vision_requeue/i.test(sql) || /ocr_unusable/i.test(sql)) {
              return { results: rows };
            }
            return { results: [] };
          },
          async run() {
            return { meta: { changes: 1 } };
          },
          async first() {
            if (/FROM filings WHERE doc_id/i.test(sql)) {
              return {
                docId: bound[0] ?? 'H-1',
                chamber: 'house',
                filerId: 'P1',
                filingType: 'P',
                filedDate: '2024-06-01',
                sourceUrl: 'u',
                rawObjectKey: 'raw/x',
                ingestStatus: 'needs_review',
                docKind: 'text_pdf',
                extractor: 'textPdf',
                modelVersion: null,
                confidence: 0.6,
                firstSeenAt: '2024-06-01',
                sourceUpdatedAt: null,
                error: null,
              };
            }
            return null;
          },
        };
        return stmt;
      },
      batch: async () => [],
    },
    INGEST_QUEUE: {
      send: async (msg: unknown) => {
        queue.push(msg);
      },
    },
    RAW_FILES: {},
  } as unknown as import('../../shared/types.ts').Env;
  return { env, queue };
}

describe('maybeRunDeterministicReviewDrain', () => {
  beforeEach(() => {
    mocks.extractAndNormalize.mockReset();
    mocks.extractParsed.mockReset();
    mocks.normalize.mockReset();
    mocks.recordIngestionDecision.mockReset().mockResolvedValue('id');
  });

  it('re-extracts deterministic review rows and counts publish', async () => {
    const { env } = makeEnv(
      [{ doc_id: 'H-1', raw_object_key: 'raw/h1.pdf', doc_kind: 'text_pdf', extractor: 'textPdf' }],
      { liveTx: 2 },
    );
    mocks.extractAndNormalize.mockResolvedValue(undefined);
    const r = await maybeRunDeterministicReviewDrain(env, { limit: 5 });
    expect(mocks.extractAndNormalize).toHaveBeenCalledWith(env, 'H-1');
    expect(r.scanned).toBe(1);
    expect(r.published).toBe(1);
    expect(r.errors).toBe(0);
  });

  it('skips non-deterministic extractors even if selected', async () => {
    const { env } = makeEnv([
      { doc_id: 'H-2', raw_object_key: 'raw/h2.pdf', doc_kind: 'scanned_pdf', extractor: 'server_cpu_v1' },
    ]);
    const r = await maybeRunDeterministicReviewDrain(env);
    expect(mocks.extractAndNormalize).not.toHaveBeenCalled();
    expect(r.skipped).toBe(1);
  });

  it('re-extracts cheap openRouterText rows on typed House PTRs', async () => {
    const { env } = makeEnv(
      [{ doc_id: 'H-2024-20025959', raw_object_key: 'raw/h.pdf', doc_kind: 'text_pdf', extractor: 'openRouterText' }],
      { liveTx: 1 },
    );
    mocks.extractAndNormalize.mockResolvedValue(undefined);
    const r = await maybeRunDeterministicReviewDrain(env, { limit: 5 });
    expect(mocks.extractAndNormalize).toHaveBeenCalledWith(env, 'H-2024-20025959');
    expect(r.scanned).toBe(1);
    expect(r.published).toBe(1);
    expect(r.skipped).toBe(0);
  });

  it('publishes a complete stored payload without re-extracting', async () => {
    const storedTx = {
      txDate: '2024-05-01',
      owner: 'self',
      assetName: 'Apple Inc',
      ticker: 'AAPL',
      assetType: 'ST',
      txType: 'B',
      amountMin: 1001,
      amountMax: 15000,
      isOption: false,
      capGainsOver200: false,
      rawText: 'AAPL',
      confidence: 0.6,
    };
    const { env } = makeEnv([{
      doc_id: 'H-stored',
      raw_object_key: 'raw/h.pdf',
      doc_kind: 'text_pdf',
      extractor: 'textPdf',
      reason: 'low_confidence',
      payload: JSON.stringify({
        transactionCount: 1,
        truncated: false,
        transactions: [storedTx],
      }),
    }]);
    mocks.normalize.mockResolvedValue({ published: true, needsReview: false, transactions: [storedTx] });
    const r = await maybeRunDeterministicReviewDrain(env, { limit: 5 });
    expect(mocks.normalize).toHaveBeenCalledTimes(1);
    expect(mocks.extractAndNormalize).not.toHaveBeenCalled();
    expect(r.published).toBe(1);
    expect(r.stillReview).toBe(0);
  });

  it('does not publish a truncated stored payload; re-extracts the full filing instead', async () => {
    const slice = Array.from({ length: 200 }, (_, i) => ({
      txDate: '2024-05-01',
      owner: 'self',
      assetName: `Muni ${i}`,
      ticker: null,
      assetType: 'GS',
      txType: 'B',
      amountMin: 1001,
      amountMax: 15000,
      isOption: false,
      capGainsOver200: false,
      rawText: `muni ${i}`,
      confidence: 0.6,
    }));
    const { env } = makeEnv(
      [{
        doc_id: 'H-truncated-219',
        raw_object_key: 'raw/large.pdf',
        doc_kind: 'text_pdf',
        extractor: 'textPdf',
        reason: 'extraction_row_limit_exceeded',
        payload: JSON.stringify({
          transactionCount: 219,
          truncated: true,
          transactions: slice,
        }),
      }],
      { liveTx: 219 },
    );
    mocks.extractAndNormalize.mockResolvedValue(undefined);
    const r = await maybeRunDeterministicReviewDrain(env, { limit: 5 });
    expect(mocks.normalize).not.toHaveBeenCalled();
    expect(mocks.extractAndNormalize).toHaveBeenCalledWith(env, 'H-truncated-219');
    expect(r.published).toBe(1);
    expect(r.stillReview).toBe(0);
  });
});

describe('sweepRejectedScannedForLocalVision', () => {
  it('requeues rejected scanned docs with raw into extraction_pending_local', async () => {
    const { env, queue } = makeEnv([{ doc_id: 'H-scan-1' }]);
    const r = await sweepRejectedScannedForLocalVision(env, { limit: 10 });
    expect(r.requeued).toBe(1);
    expect(queue).toEqual([{ type: 'filing.local_wait_check', docId: 'H-scan-1' }]);
  });
});
