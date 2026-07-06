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
            chamber: 'house',
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
        chamber: string;
        payload: { minConfidence: number; transactions: unknown[] };
      }>;
    };
    expect(body.items[0]).toMatchObject({
      docId: 'H-2026-2003695',
      sourceUrl: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/2003695.pdf',
      rawObjectKey: 'raw/H-2026-2003695',
      docKind: 'scanned_pdf',
      chamber: 'house',
      payload: { minConfidence: 0, transactions: [] },
    });
  });

  it('lists already-reviewed items with ?resolved=1 and surfaces ingest status', async () => {
    const res = await app.request(
      '/review-queue?resolved=1',
      { headers: { Authorization: 'Bearer admin-secret' } },
      {
        ADMIN_TOKEN: 'admin-secret',
        DB: fakeDb([
          {
            doc_id: 'H-2026-2003695',
            reason: 'no_transactions_extracted',
            payload: null,
            created_at: '2026-06-24T02:53:00.000Z',
            resolved: 1,
            ingest_status: 'persisted',
            source_url: 'https://example/doc',
            raw_object_key: 'raw/x',
            doc_kind: 'scanned_pdf',
          },
        ]),
      } as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resolved: boolean;
      items: Array<{ resolved: boolean; ingestStatus: string }>;
    };
    expect(body.resolved).toBe(true);
    expect(body.items[0]).toMatchObject({ resolved: true, ingestStatus: 'persisted' });
  });

  it('lists ingestion decision history separately from the review queue', async () => {
    const res = await app.request(
      '/ingestion-decisions',
      { headers: { Authorization: 'Bearer admin-secret' } },
      {
        ADMIN_TOKEN: 'admin-secret',
        DB: fakeDb([
          {
            id: 'dec-1',
            doc_id: 'S-1',
            action: 'auto_published',
            source: 'pipeline',
            actor: null,
            reason: 'passed_normalization',
            payload: '{"inserted":2}',
            transaction_ids: '["tx1","tx2"]',
            created_at: '2026-06-29T00:00:00.000Z',
            chamber: 'senate',
            ingest_status: 'persisted',
            source_url: 'https://example/senate',
          },
        ]),
      } as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      available: boolean;
      items: Array<{ docId: string; action: string; payload: { inserted: number }; transactionIds: string[] }>;
    };
    expect(body.available).toBe(true);
    expect(body.items[0]).toMatchObject({
      docId: 'S-1',
      action: 'auto_published',
      payload: { inserted: 2 },
      transactionIds: ['tx1', 'tx2'],
    });
  });

  it('unpublishes a persisted filing: soft-deletes rows, reverts, re-opens review', async () => {
    // fakeDb whose filing lookup resolves and whose UPDATE reports 3 retracted rows.
    const db = {
      prepare() {
        return {
          bind() {
            return this;
          },
          async all<T>() {
            return { results: [] as T[] };
          },
          async first<T>() {
            return { ingest_status: 'persisted' } as T;
          },
          async run() {
            return { success: true, meta: { changes: 3 } };
          },
        };
      },
    } as unknown as D1Database;

    const res = await app.request(
      '/review/H-2026-2003695/unpublish',
      { method: 'POST', headers: { Authorization: 'Bearer admin-secret' }, body: '{"reason":"bad parse"}' },
      { ADMIN_TOKEN: 'admin-secret', DB: db } as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      unpublished: boolean;
      deprecatedTransactions: number;
      reason: string;
    };
    expect(body).toMatchObject({ unpublished: true, deprecatedTransactions: 3, reason: 'bad parse' });
  });

  it('unpublish 404s when the filing does not exist', async () => {
    const res = await app.request(
      '/review/NOPE/unpublish',
      { method: 'POST', headers: { Authorization: 'Bearer admin-secret' }, body: '' },
      { ADMIN_TOKEN: 'admin-secret', DB: fakeDb([]) } as never,
    );
    expect(res.status).toBe(404);
  });

  it("decision='confirm' rejects omitted edits instead of silently publishing nothing", async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return this;
          },
          async all<T>() {
            return { results: [] as T[] };
          },
          async first<T>() {
            return { doc_id: 'H-1', resolved: 0 } as T;
          },
          async run() {
            return { success: true, meta: { changes: 1 } };
          },
        };
      },
    } as unknown as D1Database;

    const res = await app.request(
      '/review/H-1',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'confirm' }),
      },
      { ADMIN_TOKEN: 'admin-secret', DB: db } as never,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('explicit transaction edits');
  });

  it("decision='confirm' rejects empty edits instead of resolving the review item", async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return this;
          },
          async all<T>() {
            return { results: [] as T[] };
          },
          async first<T>() {
            return { doc_id: 'H-1', resolved: 0 } as T;
          },
          async run() {
            return { success: true, meta: { changes: 1 } };
          },
        };
      },
    } as unknown as D1Database;

    const res = await app.request(
      '/review/H-1',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'confirm', edits: [] }),
      },
      { ADMIN_TOKEN: 'admin-secret', DB: db } as never,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('at least one explicit transaction edit');
  });

  it("decision='manual' records hand-entered rows as source='manual'", async () => {
    // Capture the INSERT bind params so we can assert the source column = 'manual'.
    const binds: unknown[][] = [];
    const auditBinds: unknown[][] = [];
    const db = {
      prepare(sql: string) {
        return {
          _sql: sql,
          bind(...args: unknown[]) {
            if (/INSERT OR IGNORE INTO transactions/.test(sql)) binds.push(args);
            if (/INSERT INTO ingestion_decisions/.test(sql)) auditBinds.push(args);
            return this;
          },
          async all<T>() {
            return { results: [] as T[] };
          },
          async first<T>() {
            // review lookup (unresolved) + filing filer_id lookup share this shape.
            return { doc_id: 'H-1', resolved: 0, filer_id: 'P000001' } as T;
          },
          async run() {
            return { success: true, meta: { changes: 1 } };
          },
        };
      },
    } as unknown as D1Database;
    const env = {
      ADMIN_TOKEN: 'admin-secret',
      DB: db,
      DELIVERY_QUEUE: { send: async () => {}, sendBatch: async () => {} },
    } as never;

    const res = await app.request(
      '/review/H-1',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'manual', edits: [{ ticker: 'AAPL', txType: 'P', amountMin: 1001, amountMax: 15000, txDate: '2026-06-01' }] }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { decision: string; source: string; inserted: number };
    expect(body).toMatchObject({ decision: 'manual', source: 'manual', inserted: 1 });
    // The transactions INSERT bound source='manual' (it's the 17th positional bind).
    expect(binds.length).toBe(1);
    expect(binds[0]).toContain('manual');
    expect(auditBinds.length).toBe(1);
    expect(auditBinds[0]).toContain('manual');
    expect(auditBinds[0]).toContain('admin-token');
  });
});
