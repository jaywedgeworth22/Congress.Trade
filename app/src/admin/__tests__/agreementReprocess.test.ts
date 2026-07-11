import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildAdminRouter } from '../routes';

/**
 * Agreement-based auto-publish: two cross-vendor models are run per doc; when
 * they agree on the full row set the read is published, otherwise it stays in
 * review. Providers are stubbed via global.fetch; the D1 surface is an in-memory
 * fake that captures transaction inserts + filing/review updates.
 */

const app = buildAdminRouter();
const AUTH = { Authorization: 'Bearer test-admin', 'content-type': 'application/json' };

const ROW_AAPL = '[{"ticker":"AAPL","assetName":"Apple Inc.","txDate":"2026-06-19","txType":"P","amountRange":"$1,001 - $15,000","confidence":0.9}]';
const ROW_MSFT = '[{"ticker":"MSFT","assetName":"Microsoft","txDate":"2026-06-19","txType":"S","amountRange":"$1,001 - $15,000","confidence":0.9}]';

function makeEnv() {
  const insertedTx: unknown[][] = [];
  const filingUpdates: string[] = [];
  const reviewResolved: string[] = [];
  const db = {
    prepare(sql: string) {
      return {
        params: [] as unknown[],
        bind(...p: unknown[]) { this.params = p; return this; },
        async first<T>() {
          if (/SELECT doc_id, raw_object_key FROM filings/i.test(sql)) {
            return { doc_id: this.params[0], raw_object_key: 'raw/' + this.params[0] } as T;
          }
          if (/SELECT doc_id, chamber, filer_id/i.test(sql)) {
            return { doc_id: this.params[0], chamber: 'house', filer_id: 'P1', filing_type: 'P', filed_date: '2026-06-20', source_url: 'u', raw_object_key: 'raw/x', ingest_status: 'needs_review', doc_kind: 'scanned_pdf', extractor: null, model_version: null, confidence: null, first_seen_at: '2026-06-20', source_updated_at: null, error: null } as T;
          }
          return null as T | null;
        },
        async all<T>() {
          if (/FROM securities_master/i.test(sql)) return { results: [] as T[] }; // empty master → well-formed accept
          return { results: [] as T[] };
        },
        async run() {
          if (/INSERT (?:OR IGNORE )?INTO transactions/i.test(sql)) insertedTx.push(this.params);
          else if (/UPDATE filings/i.test(sql)) filingUpdates.push(String(this.params[1] ?? this.params[0]));
          else if (/UPDATE review_queue\s+SET resolved/i.test(sql)) reviewResolved.push(String(this.params[0]));
          return { success: true, meta: { changes: 1 } };
        },
      };
    },
  } as unknown as D1Database;

  const env = {
    ADMIN_TOKEN: 'test-admin',
    ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k',
    DB: db,
    RAW_FILES: { get: async () => ({ arrayBuffer: async () => new TextEncoder().encode('%PDF').buffer }) },
    DELIVERY_QUEUE: { send: async () => {}, sendBatch: async () => {} },
  } as never;
  return { env, insertedTx, reviewResolved };
}

function stubBoth(openaiText: string, anthropicText: string) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('api.openai.com')) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: openaiText } }] }) } as unknown as Response;
    }
    if (String(url).includes('api.anthropic.com')) {
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: anthropicText }] }) } as unknown as Response;
    }
    return { ok: false, status: 404, text: async () => 'nope' } as unknown as Response;
  }));
}

const MODELS = JSON.stringify([{ provider: 'openai', model: 'gpt-4o' }, { provider: 'anthropic', model: 'claude-haiku-4-5' }]);

describe('agreement-reprocess', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('dry-run (default) previews a publish on agreement without writing', async () => {
    stubBoth(ROW_AAPL, ROW_AAPL);
    const { env, insertedTx } = makeEnv();
    const res = await app.request('/agreement-reprocess', { method: 'POST', headers: AUTH, body: JSON.stringify({ docIds: ['H-1'], models: JSON.parse(MODELS) }) }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dryRun: boolean; summary: { wouldPublish: number; published: number }; results: Array<{ outcome: string }> };
    expect(body.dryRun).toBe(true);
    expect(body.summary.wouldPublish).toBe(1);
    expect(body.summary.published).toBe(0);
    expect(body.results[0].outcome).toBe('would_publish');
    expect(insertedTx).toHaveLength(0); // nothing written in dry-run
  });

  it('publishes on full agreement when dryRun=false', async () => {
    stubBoth(ROW_AAPL, ROW_AAPL);
    const { env, insertedTx, reviewResolved } = makeEnv();
    const res = await app.request('/agreement-reprocess', { method: 'POST', headers: AUTH, body: JSON.stringify({ docIds: ['H-1'], models: JSON.parse(MODELS), dryRun: false }) }, env);
    const body = (await res.json()) as { summary: { published: number }; results: Array<{ outcome: string; inserted: number }> };
    expect(body.summary.published).toBe(1);
    expect(body.results[0]).toMatchObject({ outcome: 'published', inserted: 1 });
    expect(insertedTx).toHaveLength(1);
    expect(reviewResolved).toContain('H-1');
  });

  it('keeps a doc in review when the two models disagree', async () => {
    stubBoth(ROW_AAPL, ROW_MSFT); // different tickers → row sets differ
    const { env, insertedTx } = makeEnv();
    const res = await app.request('/agreement-reprocess', { method: 'POST', headers: AUTH, body: JSON.stringify({ docIds: ['H-1'], models: JSON.parse(MODELS), dryRun: false }) }, env);
    const body = (await res.json()) as { summary: { published: number; disagree: number }; results: Array<{ outcome: string }> };
    expect(body.summary.disagree).toBe(1);
    expect(body.summary.published).toBe(0);
    expect(body.results[0].outcome).toBe('disagree');
    expect(insertedTx).toHaveLength(0);
  });

  it('rejects a request that is not exactly two models', async () => {
    const { env } = makeEnv();
    const res = await app.request('/agreement-reprocess', { method: 'POST', headers: AUTH, body: JSON.stringify({ docIds: ['H-1'], models: [{ provider: 'openai', model: 'gpt-4o' }] }) }, env);
    expect(res.status).toBe(400);
  });
});
