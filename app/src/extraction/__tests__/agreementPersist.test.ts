import { describe, it, expect, afterEach, vi } from 'vitest';
import { processAgreementDoc, type AgreementModels } from '../agreement';

/**
 * processAgreementDoc must persist EVERY candidate's per-doc reading to
 * extraction_runs (kind='agreement') via bakeoff.ts's persistExtractionRun,
 * regardless of whether the candidates agree, disagree, or dryRun is set —
 * the reading itself is unconditional; only the publish decision is gated.
 * Providers are stubbed via global.fetch; the D1 surface is an in-memory fake
 * that captures extraction_runs inserts alongside the existing transaction/
 * filing/review writes.
 */

const ROW_AAPL = '[{"ticker":"AAPL","assetName":"Apple Inc.","txType":"P","amountRange":"$1,001 - $15,000","confidence":0.9}]';
const ROW_MSFT = '[{"ticker":"MSFT","assetName":"Microsoft","txType":"S","amountRange":"$1,001 - $15,000","confidence":0.9}]';

interface ExtractionRunRow {
  id: string;
  batch_id: string | null;
  doc_id: string;
  provider: string;
  model: string;
  kind: string;
  ok: number;
  error: string | null;
  row_count: number;
  latency_ms: number;
  avg_confidence: number;
  result_json: string;
  created_at: string;
}

function makeEnv() {
  const extractionRuns: ExtractionRunRow[] = [];
  const insertedTx: unknown[][] = [];
  const db = {
    prepare(sql: string) {
      return {
        params: [] as unknown[],
        bind(...p: unknown[]) { this.params = p; return this; },
        async first<T>() {
          if (/SELECT doc_id, chamber, filer_id/i.test(sql)) {
            return {
              doc_id: this.params[0], chamber: 'house', filer_id: 'P1', filing_type: 'P',
              filed_date: '2026-06-20', source_url: 'u', raw_object_key: 'raw/x',
              ingest_status: 'needs_review', doc_kind: 'scanned_pdf', extractor: null,
              model_version: null, confidence: null, first_seen_at: '2026-06-20',
              source_updated_at: null, error: null,
            } as T;
          }
          return null as T | null;
        },
        async all<T>() {
          if (/FROM securities_master/i.test(sql)) return { results: [] as T[] };
          return { results: [] as T[] };
        },
        async run() {
          if (/INSERT INTO extraction_runs/i.test(sql)) {
            const [id, batch_id, doc_id, provider, model, kind, ok, error, row_count, latency_ms, avg_confidence, result_json, created_at] = this.params;
            extractionRuns.push({
              id, batch_id, doc_id, provider, model, kind, ok, error, row_count, latency_ms, avg_confidence, result_json, created_at,
            } as ExtractionRunRow);
          } else if (/INSERT (?:OR IGNORE )?INTO transactions/i.test(sql)) {
            insertedTx.push(this.params);
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
    },
  } as unknown as D1Database;

  const env = {
    ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k', MISTRAL_API_KEY: 'k',
    DB: db,
    RAW_FILES: { get: async () => ({ arrayBuffer: async () => new TextEncoder().encode('%PDF').buffer }) },
    DELIVERY_QUEUE: { send: async () => {}, sendBatch: async () => {} },
  } as never;
  return { env, extractionRuns, insertedTx };
}

/** Stub openai/anthropic/mistral so runCandidateOnDoc returns deterministic rows per provider. */
function stubProviders(openaiText: string, anthropicText: string, mistralText?: string) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('api.openai.com')) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: openaiText } }] }) } as unknown as Response;
    }
    if (u.includes('api.anthropic.com')) {
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: anthropicText }] }) } as unknown as Response;
    }
    if (u.includes('api.mistral.ai') && mistralText) {
      return { ok: true, json: async () => ({ document_annotation: mistralText }) } as unknown as Response;
    }
    return { ok: false, status: 404, text: async () => 'nope' } as unknown as Response;
  }));
}

const MODELS: AgreementModels = {
  a: { provider: 'openai', model: 'gpt-4o' },
  b: { provider: 'anthropic', model: 'claude-haiku-4-5' },
};

describe('processAgreementDoc extraction_runs persistence', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('persists one extraction_runs row per candidate model with kind="agreement" on agreement (dry-run)', async () => {
    stubProviders(ROW_AAPL, ROW_AAPL);
    const { env, extractionRuns } = makeEnv();
    const res = await processAgreementDoc(env, MODELS, 'H-1', 'raw/H-1', true);
    expect(res.outcome).toBe('would_publish');

    expect(extractionRuns).toHaveLength(2);
    expect(extractionRuns.every((r) => r.kind === 'agreement')).toBe(true);
    expect(extractionRuns.every((r) => r.doc_id === 'H-1')).toBe(true);
    const byProvider = Object.fromEntries(extractionRuns.map((r) => [r.provider, r]));
    expect(byProvider.openai).toMatchObject({ model: 'gpt-4o', ok: 1, row_count: 1 });
    expect(byProvider.anthropic).toMatchObject({ model: 'claude-haiku-4-5', ok: 1, row_count: 1 });
    // Same batch id groups the two reads from one processAgreementDoc call.
    expect(extractionRuns[0].batch_id).toBe(extractionRuns[1].batch_id);
    expect(extractionRuns[0].batch_id).toBeTruthy();
  });

  it('persists one row per candidate even when the models disagree (no publish)', async () => {
    stubProviders(ROW_AAPL, ROW_MSFT);
    const { env, extractionRuns, insertedTx } = makeEnv();
    const res = await processAgreementDoc(env, MODELS, 'H-2', 'raw/H-2', false);
    expect(res.outcome).toBe('disagree');
    expect(insertedTx).toHaveLength(0);

    expect(extractionRuns).toHaveLength(2);
    expect(extractionRuns.every((r) => r.kind === 'agreement')).toBe(true);
    const byProvider = Object.fromEntries(extractionRuns.map((r) => [r.provider, r]));
    expect(byProvider.openai.row_count).toBe(1);
    expect(byProvider.anthropic.row_count).toBe(1);
  });

  it('persists a row for the third model too when a consensus tier is configured', async () => {
    stubProviders(ROW_AAPL, ROW_AAPL, ROW_AAPL);
    const { env, extractionRuns } = makeEnv();
    const modelsWithC: AgreementModels = { ...MODELS, c: { provider: 'mistral', model: 'mistral-ocr-latest' } };
    const res = await processAgreementDoc(env, modelsWithC, 'H-3', 'raw/H-3', true);
    expect(res.outcome).toBe('would_publish');

    expect(extractionRuns).toHaveLength(3);
    expect(extractionRuns.every((r) => r.kind === 'agreement')).toBe(true);
    const providers = extractionRuns.map((r) => r.provider).sort();
    expect(providers).toEqual(['anthropic', 'mistral', 'openai']);
    // All three reads grouped under the same batch id.
    const batchIds = new Set(extractionRuns.map((r) => r.batch_id));
    expect(batchIds.size).toBe(1);
  });

  it('persists a structured-failure read too (e.g. an unconfigured provider key)', async () => {
    stubProviders(ROW_AAPL, ROW_AAPL);
    const { env, extractionRuns } = makeEnv();
    // Drop the mistral key so the third candidate fails with a structured error
    // rather than throwing — runCandidateOnDoc still returns an ok:false result.
    delete (env as Record<string, unknown>).MISTRAL_API_KEY;
    const modelsWithC: AgreementModels = { ...MODELS, c: { provider: 'mistral', model: 'mistral-ocr-latest' } };
    const res = await processAgreementDoc(env, modelsWithC, 'H-4', 'raw/H-4', true);
    // mistral has no configured key in this env -> third candidate fails -> disagree.
    expect(res.outcome).toBe('disagree');

    expect(extractionRuns).toHaveLength(3);
    const mistralRun = extractionRuns.find((r) => r.provider === 'mistral');
    expect(mistralRun).toMatchObject({ kind: 'agreement', ok: 0, row_count: 0 });
    expect(mistralRun?.error).toMatch(/API key not configured/);
  });
});
