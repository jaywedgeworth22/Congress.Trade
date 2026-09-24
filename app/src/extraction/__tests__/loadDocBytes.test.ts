import { describe, it, expect, afterEach, vi } from 'vitest';
import { loadDocBytes } from '../agreement.ts';

describe('loadDocBytes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function makeEnv(opts: {
    get?: (key: string) => Promise<unknown>;
    sourceUrl?: string | null;
  } = {}) {
    return {
      RAW_FILES: {
        get: opts.get ?? (async () => null),
      },
      DB: {
        prepare(sql: string) {
          return {
            bind(..._p: unknown[]) { return this; },
            async first() {
              if (/FROM filings WHERE doc_id/i.test(sql)) {
                return {
                  doc_id: 'S-1',
                  chamber: 'senate',
                  filer_id: 'P1',
                  filing_type: 'P',
                  filed_date: '2026-06-20',
                  source_url: opts.sourceUrl ?? 'https://example.test/filing.pdf',
                  raw_object_key: 'raw/S-1.pdf',
                  ingest_status: 'needs_review',
                  doc_kind: 'scanned_pdf',
                  extractor: null,
                  model_version: null,
                  confidence: null,
                  first_seen_at: '2026-06-20',
                  source_updated_at: null,
                  error: null,
                };
              }
              return null;
            },
            async all() { return { results: [] }; },
            async run() { return { success: true, meta: { changes: 0 } }; },
          };
        },
      },
    } as never;
  }

  it('returns R2 bytes when present', async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const env = makeEnv({
      get: async () => ({ arrayBuffer: async () => bytes }),
    });
    const res = await loadDocBytes(env, 'S-1', 'raw/S-1.pdf');
    expect(res).toEqual({ bytes });
  });

  it('falls back to source_url when R2 misses', async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer; // %PDF
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => pdf,
    })));
    const env = makeEnv({ get: async () => null, sourceUrl: 'https://example.test/a.pdf' });
    const res = await loadDocBytes(env, 'S-1', 'raw/S-1.pdf');
    expect(res).toEqual({ bytes: pdf });
    expect(fetch).toHaveBeenCalled();
  });

  it('skips with clear reason when R2 and source_url both fail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, arrayBuffer: async () => new ArrayBuffer(0) })));
    const env = makeEnv({ get: async () => null });
    const res = await loadDocBytes(env, 'S-1', 'raw/S-1.pdf');
    expect('skip' in res).toBe(true);
    if ('skip' in res) {
      expect(res.skip.reason).toMatch(/source_url fetch HTTP 403/);
    }
  });

  it('marks permanent 4xx skips non-retryable so capped recovery reaches review', async () => {
    // Capped recovery keeps the lease and retries a retryable skip after
    // expiry: a permanent 404 marked retryable loops forever instead of
    // reaching human review.
    for (const status of [400, 401, 403, 404, 410]) {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status, arrayBuffer: async () => new ArrayBuffer(0) })));
      const env = makeEnv({ get: async () => null });
      const res = await loadDocBytes(env, 'S-1', 'raw/S-1.pdf');
      expect('skip' in res).toBe(true);
      if ('skip' in res) {
        expect(res.skip.reason).toMatch(new RegExp(`source_url fetch HTTP ${status}`));
        expect(res.skip.retryable).toBe(false);
      }
      vi.unstubAllGlobals();
    }
  });

  it('treats a 200 with an empty body as terminal, not retryable', async () => {
    // Same capped-recovery loop as a permanent 4xx: a retryable empty body
    // keeps the lease and retries forever instead of reaching human review.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) })));
    const env = makeEnv({ get: async () => null });
    const res = await loadDocBytes(env, 'S-1', 'raw/S-1.pdf');
    expect('skip' in res).toBe(true);
    if ('skip' in res) {
      expect(res.skip.reason).toMatch(/source_url empty body/);
      expect(res.skip.retryable).toBe(false);
    }
  });

  it('keeps transient statuses retryable', async () => {
    for (const status of [408, 429, 500, 502, 503]) {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status, arrayBuffer: async () => new ArrayBuffer(0) })));
      const env = makeEnv({ get: async () => null });
      const res = await loadDocBytes(env, 'S-1', 'raw/S-1.pdf');
      expect('skip' in res).toBe(true);
      if ('skip' in res) {
        expect(res.skip.retryable).toBe(true);
      }
      vi.unstubAllGlobals();
    }
  });
});
