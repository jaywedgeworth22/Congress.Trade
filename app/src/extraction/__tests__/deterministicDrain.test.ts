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
});

describe('sweepRejectedScannedForLocalVision', () => {
  it('requeues rejected scanned docs with raw into extraction_pending_local', async () => {
    const { env, queue } = makeEnv([{ doc_id: 'H-scan-1' }]);
    const r = await sweepRejectedScannedForLocalVision(env, { limit: 10 });
    expect(r.requeued).toBe(1);
    expect(queue).toEqual([{ type: 'filing.local_wait_check', docId: 'H-scan-1' }]);
  });
});
