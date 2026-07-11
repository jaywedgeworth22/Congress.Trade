import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../shared/types';

// No pre-existing orchestrator test file to extend (only admin/reprocessHardFailure.test.ts,
// which mocks the orchestrator module entirely rather than exercising it) — this file is new,
// scoped narrowly to the raw_bytes/page_count persistence added to extractParsed().
const mocks = vi.hoisted(() => ({
  buildExtractorPipeline: vi.fn(),
}));

vi.mock('../../extractors/types', async () => {
  const actual = await vi.importActual<typeof import('../../extractors/types')>(
    '../../extractors/types',
  );
  return {
    ...actual,
    buildExtractorPipeline: mocks.buildExtractorPipeline,
  };
});

import { extractParsed } from '../orchestrator';

const FILING_ROW = {
  doc_id: 'H-1',
  chamber: 'house',
  filer_id: 'house-ca01-test-member',
  filing_type: 'P',
  filed_date: '2026-06-30',
  source_url: 'https://example.test/H-1.pdf',
  raw_object_key: 'raw/H-1.pdf',
  ingest_status: 'classified',
  doc_kind: 'text_pdf',
  extractor: null,
  model_version: null,
  confidence: null,
  first_seen_at: '2026-06-30T00:00:00.000Z',
  source_updated_at: null,
  error: null,
};

interface CapturedRun {
  sql: string;
  params: unknown[];
}

function fakeDb(): { db: D1Database; runs: CapturedRun[] } {
  const runs: CapturedRun[] = [];
  const db = {
    prepare(sql: string) {
      let params: unknown[] = [];
      return {
        bind(...p: unknown[]) {
          params = p;
          return this;
        },
        async first<T>() {
          if (/FROM filings WHERE doc_id/i.test(sql)) return FILING_ROW as unknown as T;
          return null as T | null;
        },
        async run() {
          runs.push({ sql, params });
          return { success: true, meta: { changes: 1 } };
        },
        async all<T>() {
          return { results: [] as T[] };
        },
      };
    },
  } as unknown as D1Database;
  return { db, runs };
}

function fakeRawFiles(bytes: ArrayBuffer) {
  return {
    async get() {
      return { arrayBuffer: async () => bytes } as unknown as R2ObjectBody;
    },
  } as unknown as R2Bucket;
}

describe('orchestrator complexity signals (raw_bytes / page_count)', () => {
  beforeEach(() => {
    mocks.buildExtractorPipeline.mockReset();
  });

  it('records raw_bytes and page_count after a successful extraction', async () => {
    mocks.buildExtractorPipeline.mockReturnValue([
      {
        name: 'textPdf',
        canHandle: () => true,
        extract: async () => ({
          transactions: [],
          confidence: 0.9,
          raw: 'text',
          extractor: 'textPdf',
          pageCount: 4,
        }),
      },
    ]);

    const bytes = new ArrayBuffer(1234);
    const { db, runs } = fakeDb();
    const env = { DB: db, RAW_FILES: fakeRawFiles(bytes) } as unknown as Env;

    const result = await extractParsed(env, 'H-1');
    expect(result).not.toBeNull();

    const rawBytesRun = runs.find((r) => /SET raw_bytes = \? WHERE doc_id/i.test(r.sql));
    expect(rawBytesRun?.params).toEqual([1234, 'H-1']);

    const pageCountRun = runs.find((r) => /SET page_count = \? WHERE doc_id/i.test(r.sql));
    expect(pageCountRun?.params).toEqual([4, 'H-1']);
  });

  it('records raw_bytes but skips page_count when the extractor result has no page count', async () => {
    mocks.buildExtractorPipeline.mockReturnValue([
      {
        name: 'visionLlm',
        canHandle: () => true,
        extract: async () => ({
          transactions: [],
          confidence: 0.8,
          raw: 'text',
          extractor: 'visionLlm',
          // no pageCount field — the vision path doesn't expose one cheaply.
        }),
      },
    ]);

    const bytes = new ArrayBuffer(42);
    const { db, runs } = fakeDb();
    const env = { DB: db, RAW_FILES: fakeRawFiles(bytes) } as unknown as Env;

    await extractParsed(env, 'H-1');

    const rawBytesRun = runs.find((r) => /SET raw_bytes = \? WHERE doc_id/i.test(r.sql));
    expect(rawBytesRun?.params).toEqual([42, 'H-1']);

    const pageCountRun = runs.find((r) => /SET page_count = \? WHERE doc_id/i.test(r.sql));
    expect(pageCountRun).toBeUndefined();
  });
});
