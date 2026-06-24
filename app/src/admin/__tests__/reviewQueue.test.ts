import { describe, it, expect } from 'vitest';
import { buildAdminRouter } from '../routes';

const app = buildAdminRouter();

function fakeDb(rows: unknown[]) {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return this;
        },
        async all<T>() {
          return { results: rows as T[] };
        },
        async first<T>() {
          return null as T | null;
        },
        async run() {
          return { success: true, meta: { changes: 1 } };
        },
        sql,
      };
    },
  } as unknown as D1Database;
}

describe('review queue admin API', () => {
  it('includes source document metadata for clickable review links', async () => {
    const res = await app.request(
      '/review-queue',
      { headers: { Authorization: 'Bearer admin-secret' } },
      {
        ADMIN_TOKEN: 'admin-secret',
        DB: fakeDb([
          {
            doc_id: 'H-2026-2003695',
            reason: 'no_transactions_extracted',
            payload: '{"minConfidence":0,"transactions":[]}',
            created_at: '2026-06-24T02:53:00.000Z',
            resolved: 0,
            source_url:
              'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/2003695.pdf',
            raw_object_key: 'raw/H-2026-2003695',
            doc_kind: 'scanned_pdf',
          },
        ]),
      } as never,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        docId: string;
        sourceUrl: string;
        rawObjectKey: string;
        docKind: string;
        payload: { minConfidence: number; transactions: unknown[] };
      }>;
    };
    expect(body.items[0]).toMatchObject({
      docId: 'H-2026-2003695',
      sourceUrl: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/2003695.pdf',
      rawObjectKey: 'raw/H-2026-2003695',
      docKind: 'scanned_pdf',
      payload: { minConfidence: 0, transactions: [] },
    });
  });
});
