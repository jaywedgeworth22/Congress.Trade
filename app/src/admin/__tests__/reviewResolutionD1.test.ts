import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { buildAdminRouter } from '../routes';
import { drainReviewDeliveryOutbox } from '../../delivery/reviewOutbox';
import { maybeRunAgreementAutopublish } from '../../extraction/agreement';

const app = buildAdminRouter();
const AUTH = { Authorization: 'Bearer test-admin', 'content-type': 'application/json' };
let mf: Miniflare;
let db: D1Database;

const SCHEMA = `
  CREATE TABLE review_queue (
    doc_id TEXT PRIMARY KEY, reason TEXT, payload TEXT, created_at TEXT, resolved INTEGER,
    agreement_attempted_at TEXT, agreement_attempts INTEGER NOT NULL DEFAULT 0,
    agreement_tier INTEGER, agreement_next_attempt_at TEXT, agreement_claim_token TEXT,
    agreement_claimed_at TEXT, agreement_legacy_replay_at TEXT,
    agreement_suppressed_at TEXT, agreement_suppression_reason TEXT
  );
  CREATE TABLE filings (
    doc_id TEXT PRIMARY KEY, filer_id TEXT, filed_date TEXT, ingest_status TEXT,
    raw_object_key TEXT
  );
  CREATE TABLE transactions (
    id TEXT PRIMARY KEY, doc_id TEXT, filer_id TEXT, tx_date TEXT, owner TEXT,
    asset_name TEXT, ticker TEXT, asset_type TEXT, tx_type TEXT, amount_min REAL,
    amount_max REAL, is_option INTEGER, cap_gains_over_200 INTEGER, raw_text TEXT,
    asset_type_name TEXT, filing_status TEXT, subholding TEXT, location TEXT,
    description TEXT, supplemental_text TEXT, row_key TEXT, confidence REAL,
    source TEXT, created_at TEXT, cursor_seq INTEGER, first_seen_at TEXT,
    filed_date TEXT, deprecated_at TEXT, deprecated_reason TEXT
  );
  CREATE UNIQUE INDEX idx_transactions_live_doc_source_rowkey
    ON transactions (doc_id, source, row_key)
    WHERE row_key IS NOT NULL AND deprecated_at IS NULL;
  CREATE TABLE ingestion_decisions (
    id TEXT PRIMARY KEY, doc_id TEXT, action TEXT, source TEXT, actor TEXT,
    reason TEXT, payload TEXT, transaction_ids TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  );
  CREATE TABLE review_delivery_outbox (
    tx_id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, created_at TEXT NOT NULL,
    dispatched_at TEXT, attempts INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TEXT, last_error TEXT
  );
  CREATE INDEX idx_review_delivery_outbox_pending
    ON review_delivery_outbox (dispatched_at, created_at);
`;

async function seedReview(docId: string): Promise<void> {
  await db.batch([
    db.prepare(
      `INSERT INTO filings (doc_id, filer_id, filed_date, ingest_status, raw_object_key)
       VALUES (?, 'P1', '2026-06-20', 'needs_review', ?)`,
    ).bind(docId, `raw/${docId}`),
    db.prepare(
      `INSERT INTO review_queue (doc_id, reason, payload, created_at, resolved)
       VALUES (?, 'low_confidence', '{}', '2026-06-20T00:00:00.000Z', 0)`,
    ).bind(docId),
  ]);
}

function edit(index = 0): Record<string, unknown> {
  return {
    ticker: `T${String(index).padStart(4, '0')}`,
    assetName: `Asset ${index}`,
    txType: 'P',
    txDate: '2026-06-19',
    owner: null,
    amountMin: 1001,
    amountMax: 15000,
    isOption: false,
    capGainsOver200: false,
    rawText: `source row ${index}`,
  };
}

function env(database: D1Database, sent: string[] = [], ingest: unknown[] = []): never {
  return {
    ADMIN_TOKEN: 'test-admin',
    DB: database,
    AGREEMENT_AUTOPUBLISH_ENABLED: 'true',
    INGEST_QUEUE: { send: async (message: unknown) => { ingest.push(message); } },
    DELIVERY_QUEUE: {
      send: async (message: { txId: string }) => { sent.push(message.txId); },
      sendBatch: async () => {},
    },
  } as never;
}

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-07-07',
    d1Databases: ['DB'],
  });
  db = await mf.getD1Database('DB');
  await db.batch(
    SCHEMA.split(';').map((sql) => sql.trim()).filter(Boolean).map((sql) => db.prepare(sql)),
  );
}, 30_000);

beforeEach(async () => {
  await db.batch([
    db.prepare('DELETE FROM review_delivery_outbox'),
    db.prepare('DELETE FROM ingestion_decisions'),
    db.prepare('DELETE FROM transactions'),
    db.prepare('DELETE FROM review_queue'),
    db.prepare('DELETE FROM filings'),
  ]);
});

afterAll(async () => {
  await mf.dispose();
});

describe('review resolution on transactional D1', () => {
  it('rolls back inserted edits when the exact live-set guard fails', async () => {
    await seedReview('H-ROLLBACK');
    await db.prepare(
      `INSERT INTO transactions (id, doc_id, source, row_key, deprecated_at)
       VALUES ('old-extra', 'H-ROLLBACK', 'primary', 'old-extra-key', NULL)`,
    ).run();

    const res = await app.request(
      '/review/H-ROLLBACK',
      { method: 'POST', headers: AUTH, body: JSON.stringify({ decision: 'confirm', edits: [edit()] }) },
      env(db),
    );

    expect(res.status).toBe(409);
    expect(await db.prepare(
      `SELECT COUNT(*) AS n FROM transactions WHERE doc_id = 'H-ROLLBACK'`,
    ).first<{ n: number }>('n')).toBe(1);
    expect(await db.prepare(
      `SELECT resolved FROM review_queue WHERE doc_id = 'H-ROLLBACK'`,
    ).first<number>('resolved')).toBe(0);
  });

  it('rejects a stale human submit when automation resolves before its batch', async () => {
    await seedReview('H-RACE');
    let raced = false;
    const racingDb = {
      prepare: (sql: string) => db.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        if (!raced) {
          raced = true;
          await db.prepare(`UPDATE review_queue SET resolved = 1 WHERE doc_id = 'H-RACE'`).run();
        }
        return db.batch(statements);
      },
    } as unknown as D1Database;

    const res = await app.request(
      '/review/H-RACE',
      { method: 'POST', headers: AUTH, body: JSON.stringify({ decision: 'confirm', edits: [edit()] }) },
      env(racingDb),
    );

    expect(res.status).toBe(409);
    expect(await db.prepare(
      `SELECT COUNT(*) AS n FROM transactions WHERE doc_id = 'H-RACE'`,
    ).first<{ n: number }>('n')).toBe(0);
  });

  it('confirms 223 rows with one JSON-backed insert and durable outbox intents', async () => {
    await seedReview('H-223');
    const sent: string[] = [];
    const edits = Array.from({ length: 223 }, (_, index) => edit(index));

    const res = await app.request(
      '/review/H-223',
      { method: 'POST', headers: AUTH, body: JSON.stringify({ decision: 'manual', edits }) },
      env(db, sent),
    );
    const body = (await res.json()) as { inserted?: number; resolved?: boolean };

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ inserted: 223, resolved: true });
    expect(await db.prepare(
      `SELECT COUNT(*) AS n FROM transactions WHERE doc_id = 'H-223' AND deprecated_at IS NULL`,
    ).first<{ n: number }>('n')).toBe(223);
    expect(await db.prepare(
      `SELECT COUNT(*) AS n FROM review_delivery_outbox WHERE doc_id = 'H-223'`,
    ).first<{ n: number }>('n')).toBe(223);
    expect(sent).toHaveLength(25);
  }, 30_000);

  it('retains a failed delivery intent and dispatches it on the next drain', async () => {
    await db.prepare(
      `INSERT INTO transactions (id, doc_id, source, row_key, deprecated_at)
       VALUES ('tx-retry', 'H-OUTBOX', 'primary', 'row-retry', NULL)`,
    ).run();
    await db.prepare(
      `INSERT INTO review_delivery_outbox (tx_id, doc_id, created_at)
       VALUES ('tx-retry', 'H-OUTBOX', '2026-06-20T00:00:00.000Z')`,
    ).run();
    let fail = true;
    const outboxEnv = {
      DB: db,
      DELIVERY_QUEUE: {
        send: async () => {
          if (fail) throw new Error('producer unavailable');
        },
      },
    } as never;

    expect(await drainReviewDeliveryOutbox(outboxEnv, 1)).toMatchObject({ failed: 1, dispatched: 0 });
    expect(await db.prepare(
      `SELECT attempts FROM review_delivery_outbox WHERE tx_id = 'tx-retry'`,
    ).first<number>('attempts')).toBe(1);

    fail = false;
    expect(await drainReviewDeliveryOutbox(outboxEnv, 1)).toMatchObject({ failed: 0, dispatched: 1 });
    const final = await db.prepare(
      `SELECT attempts, dispatched_at FROM review_delivery_outbox WHERE tx_id = 'tx-retry'`,
    ).first<{ attempts: number; dispatched_at: string | null }>();
    expect(final?.attempts).toBe(2);
    expect(final?.dispatched_at).toEqual(expect.any(String));
  });

  it('unpublish creates a durable hold and the live-only index permits a corrected row', async () => {
    await seedReview('H-HOLD');
    await db.prepare(`UPDATE review_queue SET resolved = 1 WHERE doc_id = 'H-HOLD'`).run();
    await db.prepare(`UPDATE filings SET ingest_status = 'persisted' WHERE doc_id = 'H-HOLD'`).run();
    await db.prepare(
      `INSERT INTO transactions (id, doc_id, source, row_key, deprecated_at)
       VALUES ('old-live', 'H-HOLD', 'primary', 'stable-key', NULL)`,
    ).run();

    const res = await app.request(
      '/review/H-HOLD/unpublish',
      { method: 'POST', headers: AUTH, body: JSON.stringify({ reason: 'wrong source row' }) },
      env(db),
    );
    expect(res.status).toBe(200);
    const hold = await db.prepare(
      `SELECT resolved, agreement_suppressed_at FROM review_queue WHERE doc_id = 'H-HOLD'`,
    ).first<{ resolved: number; agreement_suppressed_at: string | null }>();
    expect(hold?.resolved).toBe(0);
    expect(hold?.agreement_suppressed_at).toEqual(expect.any(String));
    expect(await db.prepare(
      `SELECT deprecated_at FROM transactions WHERE id = 'old-live'`,
    ).first<string>('deprecated_at')).toEqual(expect.any(String));

    await expect(db.prepare(
      `INSERT INTO transactions (id, doc_id, source, row_key, deprecated_at)
       VALUES ('corrected-live', 'H-HOLD', 'primary', 'stable-key', NULL)`,
    ).run()).resolves.toBeTruthy();
  });

  it('retry-auto clears a hold only with a readable source and acquires a fresh lease', async () => {
    await seedReview('H-RETRY');
    await db.prepare(
      `UPDATE review_queue
          SET agreement_suppressed_at = '2026-06-21T00:00:00.000Z',
              agreement_suppression_reason = 'unpublished: wrong row'
        WHERE doc_id = 'H-RETRY'`,
    ).run();
    const ingest: unknown[] = [];
    expect(await maybeRunAgreementAutopublish(env(db, [], ingest))).toMatchObject({ attempted: 0, enqueued: 0 });
    expect(ingest).toHaveLength(0);

    const res = await app.request(
      '/review/H-RETRY/retry-auto',
      { method: 'POST', headers: AUTH, body: '{}' },
      env(db, [], ingest),
    );
    expect(res.status).toBe(200);
    expect(ingest).toEqual([
      expect.objectContaining({ type: 'agreement.check', docId: 'H-RETRY', claimToken: expect.any(String) }),
    ]);
    const state = await db.prepare(
      `SELECT agreement_suppressed_at, agreement_claim_token
         FROM review_queue WHERE doc_id = 'H-RETRY'`,
    ).first<{ agreement_suppressed_at: string | null; agreement_claim_token: string | null }>();
    expect(state?.agreement_suppressed_at).toBeNull();
    expect(state?.agreement_claim_token).toEqual(expect.any(String));

    await seedReview('H-NO-SOURCE');
    await db.prepare(
      `UPDATE filings SET raw_object_key = NULL WHERE doc_id = 'H-NO-SOURCE'`,
    ).run();
    await db.prepare(
      `UPDATE review_queue SET agreement_suppressed_at = '2026-06-21T00:00:00.000Z'
        WHERE doc_id = 'H-NO-SOURCE'`,
    ).run();
    const noSource = await app.request(
      '/review/H-NO-SOURCE/retry-auto',
      { method: 'POST', headers: AUTH, body: '{}' },
      env(db),
    );
    expect(noSource.status).toBe(409);
    expect(await db.prepare(
      `SELECT agreement_suppressed_at FROM review_queue WHERE doc_id = 'H-NO-SOURCE'`,
    ).first<string>('agreement_suppressed_at')).toEqual(expect.any(String));
  });

  it('terminalizes an expired capped row once without decision churn', async () => {
    await seedReview('H-CAPPED');
    await db.prepare(
      `UPDATE review_queue
          SET agreement_attempts = 3, agreement_tier = 2,
              agreement_claim_token = NULL, agreement_claimed_at = NULL
        WHERE doc_id = 'H-CAPPED'`,
    ).run();
    const cappedEnv = {
      ...(env(db) as unknown as Record<string, unknown>),
      AGREEMENT_MAX_ATTEMPTS: '3',
    } as never;

    expect(await maybeRunAgreementAutopublish(cappedEnv)).toMatchObject({ terminalized: 1 });
    expect(await maybeRunAgreementAutopublish(cappedEnv)).toMatchObject({ terminalized: 0 });
    expect(await db.prepare(
      `SELECT reason FROM review_queue WHERE doc_id = 'H-CAPPED'`,
    ).first<string>('reason')).toBe('agreement_cascade_unresolved');
    expect(await db.prepare(
      `SELECT COUNT(*) AS n FROM ingestion_decisions
        WHERE doc_id = 'H-CAPPED' AND reason = 'cascade_unresolved'`,
    ).first<{ n: number }>('n')).toBe(1);
  });
});
