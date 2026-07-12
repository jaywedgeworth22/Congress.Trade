import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { buildAdminRouter } from '../routes';
import { DELIVERY_TARGETED_ID_LIMIT, flushDeliveryOutbox } from '../../delivery/outbox';
import { maybeRunAgreementAutopublish } from '../../extraction/agreement';
import { normalize } from '../../extraction/normalizer';
import type { Filing, ParsedTx } from '../../shared/types';

const app = buildAdminRouter();
const AUTH = { Authorization: 'Bearer test-admin', 'content-type': 'application/json' };
let mf: Miniflare;
let db: D1Database;

/**
 * This is the only suite that spawns a real workerd process (via Miniflare for
 * transactional D1). The self-hosted deploy runner's container cannot start
 * workerd — Miniflare dies with `write EPIPE` during config assembly before a
 * single test runs — which failed the whole production deploy gate while
 * hosted CI (where workerd runs fine) stayed green. Probe once up front and
 * SKIP the suite, loudly, where workerd cannot start; every environment that
 * can run it still runs every test.
 */
const workerdAvailable = await (async () => {
  try {
    const probe = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-07-07',
    });
    await probe.ready;
    await probe.dispose();
    return true;
  } catch (err) {
    console.warn(
      'reviewResolutionD1.test.ts: workerd cannot start in this environment — skipping the D1 suite:',
      (err as Error).message,
    );
    return false;
  }
})();

const SCHEMA = `
  CREATE TABLE review_queue (
    doc_id TEXT PRIMARY KEY, reason TEXT, payload TEXT, created_at TEXT, resolved INTEGER,
    agreement_attempted_at TEXT, agreement_attempts INTEGER NOT NULL DEFAULT 0,
    agreement_tier INTEGER, agreement_next_attempt_at TEXT, agreement_claim_token TEXT,
    agreement_claimed_at TEXT, agreement_legacy_replay_at TEXT,
    agreement_suppressed_at TEXT, agreement_suppression_reason TEXT,
    review_revision INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE filings (
    doc_id TEXT PRIMARY KEY, filer_id TEXT, filed_date TEXT, ingest_status TEXT,
    raw_object_key TEXT, confidence REAL, extractor TEXT, model_version TEXT,
    first_seen_at TEXT, error TEXT
  );
  CREATE TABLE transactions (
    id TEXT PRIMARY KEY, doc_id TEXT, filer_id TEXT, tx_date TEXT, owner TEXT,
    asset_name TEXT, ticker TEXT, asset_type TEXT, tx_type TEXT, amount_min REAL,
    amount_max REAL, is_option INTEGER, cap_gains_over_200 INTEGER, raw_text TEXT,
    asset_type_name TEXT, filing_status TEXT, subholding TEXT, location TEXT,
    description TEXT, supplemental_text TEXT, row_key TEXT, confidence REAL,
    source TEXT, created_at TEXT, cursor_seq INTEGER, first_seen_at TEXT,
    filed_date TEXT, deprecated_at TEXT, deprecated_reason TEXT, est_value REAL
  );
  CREATE UNIQUE INDEX idx_transactions_live_doc_source_rowkey
    ON transactions (doc_id, source, row_key)
    WHERE row_key IS NOT NULL AND deprecated_at IS NULL;
  CREATE TABLE ingestion_decisions (
    id TEXT PRIMARY KEY, doc_id TEXT, action TEXT, source TEXT, actor TEXT,
    reason TEXT, payload TEXT, transaction_ids TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  );
  CREATE TABLE delivery_outbox (
    tx_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0, dead_letter_cycles INTEGER NOT NULL DEFAULT 0,
    available_at TEXT NOT NULL, last_error TEXT, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_delivery_outbox_ready
    ON delivery_outbox (status, available_at);
  CREATE TABLE securities_master (ticker TEXT, name TEXT, aliases TEXT);
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

function filing(docId: string): Filing {
  return {
    docId,
    chamber: 'house',
    filerId: 'P1',
    filingType: 'P',
    filedDate: '2026-06-20',
    sourceUrl: 'https://example.test/filing.pdf',
    rawObjectKey: `raw/${docId}`,
    ingestStatus: 'needs_review',
    docKind: 'scanned_pdf',
    extractor: 'test',
    modelVersion: 'test-v1',
    confidence: null,
    firstSeenAt: '2026-06-20T00:00:00.000Z',
    sourceUpdatedAt: null,
    error: null,
  };
}

function parsed(overrides: Partial<ParsedTx> = {}): ParsedTx {
  return {
    ticker: 'AAPL',
    assetName: 'Apple Inc.',
    txType: 'P',
    txDate: '2026-06-19',
    owner: 'self',
    amountMin: 1001,
    amountMax: 15000,
    isOption: false,
    capGainsOver200: false,
    rawText: 'source row',
    confidence: 0.97,
    ...overrides,
  } as ParsedTx;
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
  if (!workerdAvailable) return;
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
  if (!workerdAvailable) return;
  await db.batch([
    db.prepare('DELETE FROM delivery_outbox'),
    db.prepare('DELETE FROM ingestion_decisions'),
    db.prepare('DELETE FROM transactions'),
    db.prepare('DELETE FROM review_queue'),
    db.prepare('DELETE FROM filings'),
  ]);
});

afterAll(async () => {
  if (mf) await mf.dispose();
});

describe.runIf(workerdAvailable)('review resolution on transactional D1', () => {
  it('rolls back inserted edits when the exact live-set guard fails', async () => {
    await seedReview('H-ROLLBACK');
    await db.prepare(
      `INSERT INTO transactions (id, doc_id, source, row_key, deprecated_at)
       VALUES ('old-extra', 'H-ROLLBACK', 'primary', 'old-extra-key', NULL)`,
    ).run();

    const res = await app.request(
      '/review/H-ROLLBACK',
      { method: 'POST', headers: AUTH, body: JSON.stringify({ decision: 'confirm', reviewRevision: 1, edits: [edit()] }) },
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
      { method: 'POST', headers: AUTH, body: JSON.stringify({ decision: 'confirm', reviewRevision: 1, edits: [edit()] }) },
      env(racingDb),
    );

    expect(res.status).toBe(409);
    expect(await db.prepare(
      `SELECT COUNT(*) AS n FROM transactions WHERE doc_id = 'H-RACE'`,
    ).first<{ n: number }>('n')).toBe(0);
  });

  it('rejects an editor version made stale by a payload update before its batch', async () => {
    await seedReview('H-REVISION-RACE');
    let raced = false;
    const racingDb = {
      prepare: (sql: string) => db.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        if (!raced) {
          raced = true;
          await db.prepare(
            `UPDATE review_queue
                SET reason = 'newer_extraction', payload = '{"transactions":[]}',
                    review_revision = review_revision + 1
              WHERE doc_id = 'H-REVISION-RACE'`,
          ).run();
        }
        return db.batch(statements);
      },
    } as unknown as D1Database;

    const res = await app.request(
      '/review/H-REVISION-RACE',
      {
        method: 'POST', headers: AUTH,
        body: JSON.stringify({ decision: 'confirm', reviewRevision: 1, edits: [edit()] }),
      },
      env(racingDb),
    );

    expect(res.status).toBe(409);
    expect(await db.prepare(
      `SELECT COUNT(*) AS n FROM transactions WHERE doc_id = 'H-REVISION-RACE'`,
    ).first<{ n: number }>('n')).toBe(0);
    expect(await db.prepare(
      `SELECT review_revision FROM review_queue WHERE doc_id = 'H-REVISION-RACE'`,
    ).first<number>('review_revision')).toBe(2);
  });

  it('does not deprecate rows when a reject becomes stale before its batch', async () => {
    await seedReview('H-REJECT-RACE');
    await db.prepare(
      `INSERT INTO transactions (id, doc_id, source, row_key, deprecated_at)
       VALUES ('reject-race-live', 'H-REJECT-RACE', 'primary', 'reject-race-key', NULL)`,
    ).run();
    let raced = false;
    const racingDb = {
      prepare: (sql: string) => db.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        if (!raced) {
          raced = true;
          await db.prepare(
            `UPDATE review_queue
                SET reason = 'newer_extraction', review_revision = review_revision + 1
              WHERE doc_id = 'H-REJECT-RACE'`,
          ).run();
        }
        return db.batch(statements);
      },
    } as unknown as D1Database;

    const res = await app.request(
      '/review/H-REJECT-RACE',
      {
        method: 'POST', headers: AUTH,
        body: JSON.stringify({ decision: 'reject', reviewRevision: 1 }),
      },
      env(racingDb),
    );

    expect(res.status).toBe(409);
    expect(await db.prepare(
      `SELECT deprecated_at FROM transactions WHERE id = 'reject-race-live'`,
    ).first<string | null>('deprecated_at')).toBeNull();
    expect(await db.prepare(
      `SELECT ingest_status FROM filings WHERE doc_id = 'H-REJECT-RACE'`,
    ).first<string>('ingest_status')).toBe('needs_review');
  });

  it('does not let an in-flight normalizer publish after a human reject wins', async () => {
    await seedReview('H-NORMALIZER-RACE');
    let raced = false;
    const racingDb = {
      prepare: (sql: string) => db.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        if (!raced) {
          raced = true;
          await db.batch([
            db.prepare(
              `UPDATE review_queue
                  SET resolved = 1, reason = 'rejected: human won',
                      agreement_suppressed_at = '2026-06-21T00:00:00.000Z',
                      agreement_suppression_reason = 'rejected: human won',
                      review_revision = review_revision + 1
                WHERE doc_id = 'H-NORMALIZER-RACE'`,
            ),
            db.prepare(
              `UPDATE filings SET ingest_status = 'error'
                WHERE doc_id = 'H-NORMALIZER-RACE'`,
            ),
          ]);
        }
        return db.batch(statements);
      },
    } as unknown as D1Database;

    const result = await normalize(
      { ...(env(racingDb) as unknown as Record<string, unknown>), DB: racingDb } as never,
      filing('H-NORMALIZER-RACE'),
      [parsed()],
    );

    expect(result.published).toBe(false);
    expect(await db.prepare(
      `SELECT COUNT(*) AS n FROM transactions WHERE doc_id = 'H-NORMALIZER-RACE'`,
    ).first<{ n: number }>('n')).toBe(0);
    expect(await db.prepare(
      `SELECT COUNT(*) AS n FROM delivery_outbox o
         JOIN transactions t ON t.id = o.tx_id
        WHERE t.doc_id = 'H-NORMALIZER-RACE'`,
    ).first<{ n: number }>('n')).toBe(0);
    expect(await db.prepare(
      `SELECT ingest_status FROM filings WHERE doc_id = 'H-NORMALIZER-RACE'`,
    ).first<string>('ingest_status')).toBe('error');
  });

  it('atomically publishes a first-pass normalized filing with value and outbox intent', async () => {
    await db.prepare(
      `INSERT INTO filings (doc_id, filer_id, filed_date, ingest_status, raw_object_key)
       VALUES ('H-NORMALIZER-FRESH', 'P1', '2026-06-20', 'extracted', 'raw/H-NORMALIZER-FRESH')`,
    ).run();
    const sent: string[] = [];

    const result = await normalize(
      env(db, sent),
      filing('H-NORMALIZER-FRESH'),
      [parsed()],
    );

    expect(result).toMatchObject({ published: true, needsReview: false });
    expect(await db.prepare(
      `SELECT est_value FROM transactions WHERE doc_id = 'H-NORMALIZER-FRESH'`,
    ).first<number>('est_value')).toBe(8000.5);
    expect(await db.prepare(
      `SELECT ingest_status FROM filings WHERE doc_id = 'H-NORMALIZER-FRESH'`,
    ).first<string>('ingest_status')).toBe('persisted');
    expect(await db.prepare(
      `SELECT o.status FROM delivery_outbox o
         JOIN transactions t ON t.id = o.tx_id
        WHERE t.doc_id = 'H-NORMALIZER-FRESH'`,
    ).first<string>('status')).toBe('enqueued');
    expect(sent).toHaveLength(1);
  });

  it('atomically resolves the captured review revision during normalized publish', async () => {
    await seedReview('H-NORMALIZER-REVIEWED');

    const result = await normalize(
      env(db),
      filing('H-NORMALIZER-REVIEWED'),
      [parsed()],
    );

    expect(result.published).toBe(true);
    const review = await db.prepare(
      `SELECT resolved, review_revision FROM review_queue
        WHERE doc_id = 'H-NORMALIZER-REVIEWED'`,
    ).first<{ resolved: number; review_revision: number }>();
    expect(review).toEqual({ resolved: 1, review_revision: 2 });
    expect(await db.prepare(
      `SELECT COUNT(*) AS n FROM transactions WHERE doc_id = 'H-NORMALIZER-REVIEWED'`,
    ).first<{ n: number }>('n')).toBe(1);
  });

  it('does not reopen a review when a human confirm wins before review routing', async () => {
    await seedReview('H-REVIEW-OPEN-RACE');
    let raced = false;
    const racingDb = {
      prepare: (sql: string) => db.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        if (!raced) {
          raced = true;
          await db.batch([
            db.prepare(
              `UPDATE review_queue
                  SET resolved = 1, reason = 'confirmed by human',
                      review_revision = review_revision + 1
                WHERE doc_id = 'H-REVIEW-OPEN-RACE'`,
            ),
            db.prepare(
              `UPDATE filings SET ingest_status = 'persisted'
                WHERE doc_id = 'H-REVIEW-OPEN-RACE'`,
            ),
          ]);
        }
        return db.batch(statements);
      },
    } as unknown as D1Database;

    const result = await normalize(
      { ...(env(racingDb) as unknown as Record<string, unknown>), DB: racingDb } as never,
      filing('H-REVIEW-OPEN-RACE'),
      [parsed({ ticker: 'Bad Ticker', assetName: 'Mystery Co.' })],
    );

    expect(result).toMatchObject({ needsReview: false, published: false });
    const state = await db.prepare(
      `SELECT resolved, reason, review_revision FROM review_queue
        WHERE doc_id = 'H-REVIEW-OPEN-RACE'`,
    ).first<{ resolved: number; reason: string; review_revision: number }>();
    expect(state).toEqual({ resolved: 1, reason: 'confirmed by human', review_revision: 2 });
    expect(await db.prepare(
      `SELECT ingest_status FROM filings WHERE doc_id = 'H-REVIEW-OPEN-RACE'`,
    ).first<string>('ingest_status')).toBe('persisted');
  });

  it('does not open a stale low-confidence review after a first-pass publish wins', async () => {
    await db.prepare(
      `INSERT INTO filings (doc_id, filer_id, filed_date, ingest_status, raw_object_key)
       VALUES ('H-FIRST-PASS-RACE', 'P1', '2026-06-20', 'extracted', 'raw/H-FIRST-PASS-RACE')`,
    ).run();
    let raced = false;
    const racingDb = {
      prepare: (sql: string) => db.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        if (!raced) {
          raced = true;
          const winner = await normalize(
            env(db),
            filing('H-FIRST-PASS-RACE'),
            [parsed()],
          );
          expect(winner.published).toBe(true);
        }
        return db.batch(statements);
      },
    } as unknown as D1Database;

    const loser = await normalize(
      { ...(env(racingDb) as unknown as Record<string, unknown>), DB: racingDb } as never,
      filing('H-FIRST-PASS-RACE'),
      [parsed({ ticker: 'Bad Ticker', assetName: 'Mystery Co.' })],
    );

    expect(loser).toMatchObject({ needsReview: false, published: false });
    expect(await db.prepare(
      `SELECT COUNT(*) AS n FROM review_queue WHERE doc_id = 'H-FIRST-PASS-RACE'`,
    ).first<{ n: number }>('n')).toBe(0);
    expect(await db.prepare(
      `SELECT COUNT(*) AS n FROM transactions WHERE doc_id = 'H-FIRST-PASS-RACE'`,
    ).first<{ n: number }>('n')).toBe(1);
    expect(await db.prepare(
      `SELECT ingest_status FROM filings WHERE doc_id = 'H-FIRST-PASS-RACE'`,
    ).first<string>('ingest_status')).toBe('persisted');
  });

  it('refreshes pending review content without resetting capped attempts or backoff', async () => {
    await seedReview('H-PRESERVE-CAP');
    await db.prepare(
      `UPDATE review_queue
          SET agreement_attempted_at = '2026-06-21T00:00:00.000Z',
              agreement_attempts = 3,
              agreement_tier = 2,
              agreement_next_attempt_at = '2026-06-22T00:00:00.000Z',
              agreement_claim_token = 'old-claim',
              agreement_claimed_at = '2026-06-21T00:00:00.000Z'
        WHERE doc_id = 'H-PRESERVE-CAP'`,
    ).run();

    const result = await normalize(
      env(db),
      filing('H-PRESERVE-CAP'),
      [parsed({ ticker: 'Bad Ticker', assetName: 'Mystery Co.' })],
    );

    expect(result).toMatchObject({ needsReview: true, published: false });
    const state = await db.prepare(
      `SELECT agreement_attempts, agreement_tier, agreement_next_attempt_at,
              agreement_claim_token, agreement_claimed_at, review_revision
         FROM review_queue WHERE doc_id = 'H-PRESERVE-CAP'`,
    ).first<{
      agreement_attempts: number;
      agreement_tier: number;
      agreement_next_attempt_at: string;
      agreement_claim_token: string | null;
      agreement_claimed_at: string | null;
      review_revision: number;
    }>();
    expect(state).toEqual({
      agreement_attempts: 3,
      agreement_tier: 2,
      agreement_next_attempt_at: '2026-06-22T00:00:00.000Z',
      agreement_claim_token: null,
      agreement_claimed_at: null,
      review_revision: 2,
    });
  });

  it('lets only one of two confirmations resolve the same review revision', async () => {
    await seedReview('H-DOUBLE');

    const first = await app.request(
      '/review/H-DOUBLE',
      {
        method: 'POST', headers: AUTH,
        body: JSON.stringify({ decision: 'confirm', reviewRevision: 1, edits: [edit()] }),
      },
      env(db),
    );
    const second = await app.request(
      '/review/H-DOUBLE',
      {
        method: 'POST', headers: AUTH,
        body: JSON.stringify({ decision: 'confirm', reviewRevision: 1, edits: [edit()] }),
      },
      env(db),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(await db.prepare(
      `SELECT COUNT(*) AS n FROM transactions WHERE doc_id = 'H-DOUBLE' AND deprecated_at IS NULL`,
    ).first<{ n: number }>('n')).toBe(1);
    expect(await db.prepare(
      `SELECT COUNT(*) AS n FROM delivery_outbox o
         JOIN transactions t ON t.id = o.tx_id
        WHERE t.doc_id = 'H-DOUBLE'`,
    ).first<{ n: number }>('n')).toBe(1);
  });

  it('rejects a stale unpublish without retracting the newer live filing', async () => {
    await seedReview('H-STALE-UNPUBLISH');
    await db.prepare(
      `UPDATE review_queue SET resolved = 1, review_revision = 2
        WHERE doc_id = 'H-STALE-UNPUBLISH'`,
    ).run();
    await db.prepare(
      `UPDATE filings SET ingest_status = 'persisted' WHERE doc_id = 'H-STALE-UNPUBLISH'`,
    ).run();
    await db.prepare(
      `INSERT INTO transactions (id, doc_id, source, row_key, deprecated_at)
       VALUES ('newer-live', 'H-STALE-UNPUBLISH', 'primary', 'newer-key', NULL)`,
    ).run();

    const res = await app.request(
      '/review/H-STALE-UNPUBLISH/unpublish',
      {
        method: 'POST', headers: AUTH,
        body: JSON.stringify({ reviewRevision: 1, reason: 'stale tab' }),
      },
      env(db),
    );

    expect(res.status).toBe(409);
    expect(await db.prepare(
      `SELECT deprecated_at FROM transactions WHERE id = 'newer-live'`,
    ).first<string | null>('deprecated_at')).toBeNull();
    expect(await db.prepare(
      `SELECT ingest_status FROM filings WHERE doc_id = 'H-STALE-UNPUBLISH'`,
    ).first<string>('ingest_status')).toBe('persisted');
  });

  it('keeps a hold when Retry Auto is submitted from a stale revision', async () => {
    await seedReview('H-STALE-RETRY');
    await db.prepare(
      `UPDATE review_queue
          SET agreement_suppressed_at = '2026-06-21T00:00:00.000Z',
              agreement_suppression_reason = 'unpublished: corrected again',
              review_revision = 2
        WHERE doc_id = 'H-STALE-RETRY'`,
    ).run();
    const ingest: unknown[] = [];

    const res = await app.request(
      '/review/H-STALE-RETRY/retry-auto',
      { method: 'POST', headers: AUTH, body: JSON.stringify({ reviewRevision: 1 }) },
      env(db, [], ingest),
    );

    expect(res.status).toBe(409);
    expect(ingest).toHaveLength(0);
    expect(await db.prepare(
      `SELECT agreement_suppressed_at FROM review_queue WHERE doc_id = 'H-STALE-RETRY'`,
    ).first<string>('agreement_suppressed_at')).toBe('2026-06-21T00:00:00.000Z');
  });

  it('confirms 223 rows with one JSON-backed insert and durable outbox intents', async () => {
    await seedReview('H-223');
    const sent: string[] = [];
    const edits = Array.from({ length: 223 }, (_, index) => edit(index));

    const res = await app.request(
      '/review/H-223',
      { method: 'POST', headers: AUTH, body: JSON.stringify({ decision: 'manual', reviewRevision: 1, edits }) },
      env(db, sent),
    );
    const body = (await res.json()) as { inserted?: number; resolved?: boolean };

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ inserted: 223, resolved: true });
    expect(await db.prepare(
      `SELECT COUNT(*) AS n FROM transactions WHERE doc_id = 'H-223' AND deprecated_at IS NULL`,
    ).first<{ n: number }>('n')).toBe(223);
    expect(await db.prepare(
      `SELECT COUNT(*) AS n FROM transactions
        WHERE doc_id = 'H-223' AND est_value = 8000.5`,
    ).first<{ n: number }>('n')).toBe(223);
    expect(await db.prepare(
      `SELECT COUNT(*) AS n FROM delivery_outbox o
         JOIN transactions t ON t.id = o.tx_id
        WHERE t.doc_id = 'H-223'`,
    ).first<{ n: number }>('n')).toBe(223);
    const deliveryState = await db.prepare(
      `SELECT
         SUM(CASE WHEN o.status = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN o.status = 'enqueued' THEN 1 ELSE 0 END) AS enqueued
       FROM delivery_outbox o
       JOIN transactions t ON t.id = o.tx_id
       WHERE t.doc_id = 'H-223'`,
    ).first<{ pending: number; enqueued: number }>();
    expect(deliveryState).toEqual({
      pending: 223 - DELIVERY_TARGETED_ID_LIMIT,
      enqueued: DELIVERY_TARGETED_ID_LIMIT,
    });
    expect(sent).toHaveLength(DELIVERY_TARGETED_ID_LIMIT);
  }, 30_000);

  it('atomically clears a human hold when a fresh editor confirms corrected rows', async () => {
    await seedReview('H-CONFIRM-HOLD');
    await db.prepare(
      `UPDATE review_queue
          SET agreement_suppressed_at = '2026-06-21T00:00:00.000Z',
              agreement_suppression_reason = 'unpublished: wrong row'
        WHERE doc_id = 'H-CONFIRM-HOLD'`,
    ).run();

    const res = await app.request(
      '/review/H-CONFIRM-HOLD',
      {
        method: 'POST', headers: AUTH,
        body: JSON.stringify({ decision: 'confirm', reviewRevision: 1, edits: [edit()] }),
      },
      env(db),
    );

    expect(res.status).toBe(200);
    const state = await db.prepare(
      `SELECT resolved, agreement_suppressed_at, agreement_suppression_reason, review_revision
         FROM review_queue WHERE doc_id = 'H-CONFIRM-HOLD'`,
    ).first<{
      resolved: number;
      agreement_suppressed_at: string | null;
      agreement_suppression_reason: string | null;
      review_revision: number;
    }>();
    expect(state).toEqual({
      resolved: 1,
      agreement_suppressed_at: null,
      agreement_suppression_reason: null,
      review_revision: 2,
    });
  });

  it('retains a failed delivery intent and enqueues it on the next eligible flush', async () => {
    await db.prepare(
      `INSERT INTO transactions (id, doc_id, source, row_key, deprecated_at)
       VALUES ('tx-retry', 'H-OUTBOX', 'primary', 'row-retry', NULL)`,
    ).run();
    await db.prepare(
      `INSERT INTO delivery_outbox
         (tx_id, status, attempts, dead_letter_cycles, available_at, last_error, created_at, updated_at)
       VALUES ('tx-retry', 'pending', 0, 0, '2026-06-20T00:00:00.000Z', NULL,
               '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z')`,
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
    const firstAttempt = new Date('2026-06-20T00:00:00.000Z');

    expect(await flushDeliveryOutbox(outboxEnv, {
      txIds: ['tx-retry'], limit: 1, now: firstAttempt,
    })).toEqual({ claimed: 1, failed: 1, enqueued: 0 });
    expect(await db.prepare(
      `SELECT attempts, status, last_error FROM delivery_outbox WHERE tx_id = 'tx-retry'`,
    ).first<{ attempts: number; status: string; last_error: string | null }>()).toEqual({
      attempts: 1,
      status: 'pending',
      last_error: 'producer unavailable',
    });

    fail = false;
    expect(await flushDeliveryOutbox(outboxEnv, {
      txIds: ['tx-retry'], limit: 1, now: new Date(firstAttempt.getTime() + 6_000),
    })).toEqual({ claimed: 1, failed: 0, enqueued: 1 });
    const final = await db.prepare(
      `SELECT attempts, status, last_error FROM delivery_outbox WHERE tx_id = 'tx-retry'`,
    ).first<{ attempts: number; status: string; last_error: string | null }>();
    expect(final?.attempts).toBe(2);
    expect(final?.status).toBe('enqueued');
    expect(final?.last_error).toBeNull();
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
      {
        method: 'POST', headers: AUTH,
        body: JSON.stringify({ reason: 'wrong source row', reviewRevision: 1 }),
      },
      env(db),
    );
    expect(res.status).toBe(200);
    const hold = await db.prepare(
      `SELECT resolved, agreement_suppressed_at, review_revision
         FROM review_queue WHERE doc_id = 'H-HOLD'`,
    ).first<{ resolved: number; agreement_suppressed_at: string | null; review_revision: number }>();
    expect(hold?.resolved).toBe(0);
    expect(hold?.agreement_suppressed_at).toEqual(expect.any(String));
    expect(hold?.review_revision).toBe(2);
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
      { method: 'POST', headers: AUTH, body: JSON.stringify({ reviewRevision: 1 }) },
      env(db, [], ingest),
    );
    expect(res.status).toBe(200);
    expect(ingest).toEqual([
      expect.objectContaining({ type: 'agreement.check', docId: 'H-RETRY', claimToken: expect.any(String) }),
    ]);
    const state = await db.prepare(
      `SELECT agreement_suppressed_at, agreement_claim_token, review_revision
         FROM review_queue WHERE doc_id = 'H-RETRY'`,
    ).first<{
      agreement_suppressed_at: string | null;
      agreement_claim_token: string | null;
      review_revision: number;
    }>();
    expect(state?.agreement_suppressed_at).toBeNull();
    expect(state?.agreement_claim_token).toEqual(expect.any(String));
    expect(state?.review_revision).toBe(2);

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
      { method: 'POST', headers: AUTH, body: JSON.stringify({ reviewRevision: 1 }) },
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
