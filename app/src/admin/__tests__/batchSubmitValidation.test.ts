import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../shared/types';
import { buildAdminRouter } from '../routes';

const AUTH = { Authorization: 'Bearer test-admin' };

function makeEnv() {
  const queriedDocIds: string[] = [];
  const insertedJobs: unknown[][] = [];
  const prepare = (sql: string) => ({
    params: [] as unknown[],
    bind(...params: unknown[]) {
      this.params = params;
      return this;
    },
    async first<T>() {
      if (/FROM filings WHERE doc_id = \?/i.test(sql)) {
        const docId = String(this.params[0]);
        queriedDocIds.push(docId);
        return {
          doc_id: docId,
          raw_object_key: `raw/${docId}.pdf`,
          chamber: 'house',
        } as T;
      }
      return null as T | null;
    },
    async all() {
      throw new Error('explicit docIds must not query the default backlog');
    },
    async run() {
      if (/INSERT INTO batch_jobs/i.test(sql)) insertedJobs.push([...this.params]);
      return { success: true, meta: { changes: 1 } };
    },
  });
  const bytes = new TextEncoder().encode('%PDF-1.4 test').buffer as ArrayBuffer;
  const env = {
    ADMIN_TOKEN: 'test-admin',
    ANTHROPIC_API_KEY: 'test-anthropic-key',
    DB: { prepare } as unknown as D1Database,
    RAW_FILES: {
      get: vi.fn(async () => ({ arrayBuffer: async () => bytes })),
    },
  } as unknown as Env;
  return { env, queriedDocIds, insertedJobs };
}

afterEach(() => vi.unstubAllGlobals());

describe('POST /batch-submit explicit docIds', () => {
  it('trims and deduplicates ids before applying the requested limit or querying', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      Response.json({ id: 'provider-batch-1' })
    ));
    vi.stubGlobal('fetch', fetchMock);
    const { env, queriedDocIds, insertedJobs } = makeEnv();

    const response = await buildAdminRouter().request('/batch-submit', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'anthropic',
        n: 2,
        docIds: [' H-1 ', 'H-1', 'H-2', ' H-2 '],
      }),
    }, env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ docCount: 2 });
    expect(queriedDocIds).toEqual(['H-1', 'H-2']);
    expect(fetchMock).toHaveBeenCalledOnce();
    const providerBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(providerBody.requests.map((request: { custom_id: string }) => request.custom_id))
      .toEqual(['H-1', 'H-2']);
    expect(insertedJobs).toHaveLength(1);
    expect(JSON.parse(String(insertedJobs[0]?.[4]))).toEqual(['H-1', 'H-2']);
  });

  it.each([
    { docIds: [], requestedDocCount: 0, invalidDocIdCount: 0 },
    { docIds: ['H-1', '   '], requestedDocCount: 2, invalidDocIdCount: 1 },
    { docIds: ['H-1', 7], requestedDocCount: 2, invalidDocIdCount: 1 },
  ])('rejects empty or malformed explicit ids without querying providers', async ({
    docIds,
    requestedDocCount,
    invalidDocIdCount,
  }) => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      Response.json({ id: 'must-not-run' })
    ));
    vi.stubGlobal('fetch', fetchMock);
    const { env, queriedDocIds, insertedJobs } = makeEnv();

    const response = await buildAdminRouter().request('/batch-submit', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'anthropic', docIds }),
    }, env);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'docIds must contain only non-empty strings',
      requestedDocCount,
      invalidDocIdCount,
    });
    expect(queriedDocIds).toEqual([]);
    expect(insertedJobs).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
