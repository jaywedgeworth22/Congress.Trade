import { describe, it, expect, afterEach, vi } from 'vitest';
import { maybeRunAgreementAutopublish } from '../agreement';

/**
 * The autonomous per-minute pass: self-gates on the flag, picks unattempted
 * review docs, publishes the ones that agree, and stamps every attempt so a
 * disagreement is never re-read. Providers stubbed via global.fetch.
 */

const ROW_AAPL = '[{"ticker":"AAPL","assetName":"Apple Inc.","txType":"P","amountRange":"$1,001 - $15,000","confidence":0.9}]';

function makeEnv(flag: string | undefined) {
  const inserted: unknown[][] = [];
  const attempted: string[] = [];
  const resolved: string[] = [];
  const db = {
    prepare(sql: string) {
      return {
        params: [] as unknown[],
        bind(...p: unknown[]) { this.params = p; return this; },
        async first<T>() {
          if (/SELECT doc_id, chamber, filer_id/i.test(sql)) {
            return { doc_id: this.params[0], chamber: 'house', filer_id: 'P1', filing_type: 'P', filed_date: '2026-06-20', source_url: 'u', raw_object_key: 'raw/x', ingest_status: 'needs_review', doc_kind: 'scanned_pdf', extractor: null, model_version: null, confidence: null, first_seen_at: '2026-06-20', source_updated_at: null, error: null } as T;
          }
          return null as T | null;
        },
        async all<T>() {
          if (/FROM review_queue rq JOIN filings/i.test(sql)) {
            return { results: [{ doc_id: 'H-AP-1', raw_object_key: 'raw/H-AP-1' }] as T[] };
          }
          if (/FROM securities_master/i.test(sql)) return { results: [] as T[] };
          return { results: [] as T[] };
        },
        async run() {
          if (/INSERT (?:OR IGNORE )?INTO transactions/i.test(sql)) inserted.push(this.params);
          else if (/UPDATE review_queue SET agreement_attempted_at/i.test(sql)) attempted.push(String(this.params[1]));
          else if (/UPDATE review_queue SET resolved/i.test(sql)) resolved.push(String(this.params[0]));
          return { success: true, meta: { changes: 1 } };
        },
      };
    },
  } as unknown as D1Database;

  const env = {
    AGREEMENT_AUTOPUBLISH_ENABLED: flag,
    ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k', GEMINI_API_KEY: 'k', MISTRAL_API_KEY: 'k',
    AGREEMENT_AUTOPUBLISH_MODEL_A: 'openai:gpt-4o',
    AGREEMENT_AUTOPUBLISH_MODEL_B: 'anthropic:claude-haiku-4-5',
    DB: db,
    RAW_FILES: { get: async () => ({ arrayBuffer: async () => new TextEncoder().encode('%PDF').buffer }) },
    DELIVERY_QUEUE: { send: async () => {} },
  } as never;
  return { env, inserted, attempted, resolved };
}

function stubAgree(text: string) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('api.openai.com')) return { ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) } as unknown as Response;
    if (String(url).includes('api.anthropic.com')) return { ok: true, json: async () => ({ content: [{ type: 'text', text }] }) } as unknown as Response;
    return { ok: false, status: 404, text: async () => 'x' } as unknown as Response;
  }));
}

describe('maybeRunAgreementAutopublish', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is a no-op when the flag is off', async () => {
    const { env, inserted } = makeEnv(undefined);
    const out = await maybeRunAgreementAutopublish(env);
    expect(out).toBeNull();
    expect(inserted).toHaveLength(0);
  });

  it('publishes an agreeing doc and stamps the attempt', async () => {
    stubAgree(ROW_AAPL);
    const { env, inserted, attempted, resolved } = makeEnv('true');
    const out = await maybeRunAgreementAutopublish(env);
    expect(out).toMatchObject({ attempted: 1, published: 1 });
    expect(inserted).toHaveLength(1);
    expect(resolved).toContain('H-AP-1');
    expect(attempted).toContain('H-AP-1'); // attempt stamped so it won't re-run
  });
});
