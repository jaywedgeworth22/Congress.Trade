import { afterEach, describe, expect, it } from 'vitest';
import type { Env } from '../../shared/types.ts';
import { maybeRunAgreementAutopublish } from '../agreement.ts';
import {
  BONDI_EMPTY_DOC_ID,
  closeVerifiedEmptyExecutive,
  sweepKnownParkedExecutiveTerminals,
  TRUMP_UNREADABLE_DOC_ID,
} from '../executiveDisposition.ts';

interface SqliteRunResult {
  changes: number | bigint;
}

interface SqliteStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
  run(...params: unknown[]): SqliteRunResult;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

let openDatabase: SqliteDatabase | null = null;

async function sqliteDatabase(): Promise<SqliteDatabase> {
  const sqlite = await import('node:sqlite') as SqliteModule;
  const db = new sqlite.DatabaseSync(':memory:');
  openDatabase = db;
  db.exec(`
    CREATE TABLE filings (
      doc_id TEXT PRIMARY KEY,
      chamber TEXT,
      ingest_status TEXT,
      error TEXT,
      doc_kind TEXT,
      raw_object_key TEXT,
      extractor TEXT
    );
    CREATE TABLE review_queue (
      doc_id TEXT PRIMARY KEY,
      reason TEXT,
      payload TEXT,
      created_at TEXT,
      resolved INTEGER,
      agreement_attempts INTEGER,
      agreement_tier INTEGER,
      agreement_claim_token TEXT,
      agreement_claimed_at TEXT,
      agreement_suppressed_at TEXT,
      agreement_next_attempt_at TEXT,
      review_revision INTEGER NOT NULL DEFAULT 1,
      resolution_kind TEXT,
      resolution_reason TEXT,
      resolved_at TEXT
    );
    CREATE TABLE transactions (
      doc_id TEXT,
      source TEXT,
      deprecated_at TEXT
    );
    CREATE TABLE extraction_runs (
      doc_id TEXT,
      ok INTEGER,
      row_count INTEGER,
      result_json TEXT
    );
    CREATE TABLE ingestion_decisions (
      id TEXT PRIMARY KEY,
      doc_id TEXT,
      action TEXT,
      source TEXT,
      actor TEXT,
      reason TEXT,
      payload TEXT,
      transaction_ids TEXT,
      created_at TEXT
    );
    CREATE TRIGGER trg_review_queue_honest_resolution
    BEFORE UPDATE OF resolved ON review_queue
    WHEN NEW.resolved = 1 AND (
      NEW.resolution_kind IS NULL
      OR NEW.resolution_kind NOT IN ('published', 'verified_empty', 'rejected', 'orphan_deleted')
      OR (
        NEW.resolution_kind IN ('verified_empty', 'rejected')
        AND (NEW.resolution_reason IS NULL OR TRIM(NEW.resolution_reason) = '')
      )
      OR (
        NEW.resolution_kind = 'published'
        AND NOT EXISTS (
          SELECT 1 FROM transactions WHERE doc_id = NEW.doc_id AND deprecated_at IS NULL
        )
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'honest resolution required');
    END;
  `);
  return db;
}

function d1Database(db: SqliteDatabase): D1Database {
  return {
    prepare(sql: string) {
      let params: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          params = values;
          return this;
        },
        async first<T>() {
          return (db.prepare(sql).get(...params) ?? null) as T | null;
        },
        async run() {
          const result = db.prepare(sql).run(...params);
          return { success: true, meta: { changes: Number(result.changes) } };
        },
        async all<T>() {
          return { results: db.prepare(sql).all(...params) as T[] };
        },
      };
    },
  } as unknown as D1Database;
}

function envFor(db: SqliteDatabase): Env {
  return {
    DB: d1Database(db),
    AGREEMENT_AUTOPUBLISH_ENABLED: 'true',
    AGREEMENT_MAX_ATTEMPTS: '3',
    INGEST_QUEUE: { send: async () => {} },
  } as unknown as Env;
}

function seedReview(
  db: SqliteDatabase,
  docId: string,
  reason: string,
  attempts = 3,
): void {
  db.prepare(
    `INSERT INTO filings (doc_id, chamber, ingest_status, doc_kind, extractor)
     VALUES (?, 'executive', 'needs_review', 'text_pdf', 'ogeText')`,
  ).run(docId);
  db.prepare(
    `INSERT INTO review_queue (doc_id, reason, payload, created_at, resolved, agreement_attempts, review_revision)
     VALUES (?, ?, '{}', '2026-09-01T00:00:00.000Z', 0, ?, 1)`,
  ).run(docId, reason, attempts);
}

afterEach(() => {
  openDatabase?.close();
  openDatabase = null;
});

describe('sweepKnownParkedExecutiveTerminals', () => {
  it('closes Bondi as verified_empty and Trump as unreadable, then no-ops', async () => {
    const db = await sqliteDatabase();
    seedReview(db, BONDI_EMPTY_DOC_ID, 'agreement_cascade_unresolved');
    seedReview(db, TRUMP_UNREADABLE_DOC_ID, 'agreement_cascade_unresolved');
    seedReview(db, 'E-other-still-open', 'agreement_cascade_unresolved');
    const env = envFor(db);

    const first = await sweepKnownParkedExecutiveTerminals(env);
    expect(first).toEqual({ verifiedEmpty: 1, unreadable: 1 });

    const bondi = db.prepare(
      `SELECT rq.resolved, rq.resolution_kind, rq.resolution_reason, f.ingest_status, f.error
         FROM review_queue rq JOIN filings f ON f.doc_id = rq.doc_id
        WHERE rq.doc_id = ?`,
    ).get(BONDI_EMPTY_DOC_ID) as Record<string, unknown>;
    expect(bondi).toMatchObject({
      resolved: 1,
      resolution_kind: 'verified_empty',
      resolution_reason: 'executive_278e_no_transactions',
      ingest_status: 'verified_empty',
      error: null,
    });

    const trump = db.prepare(
      `SELECT rq.resolved, rq.resolution_kind, rq.resolution_reason, rq.reason, f.ingest_status
         FROM review_queue rq JOIN filings f ON f.doc_id = rq.doc_id
        WHERE rq.doc_id = ?`,
    ).get(TRUMP_UNREADABLE_DOC_ID) as Record<string, unknown>;
    expect(trump).toMatchObject({
      resolved: 1,
      resolution_kind: 'rejected',
      resolution_reason: 'oge_text_unreadable',
      ingest_status: 'error',
    });
    expect(String(trump.reason)).toContain('ocr_unusable');
    expect(String(trump.reason)).toContain('oge_text_unreadable');

    const other = db.prepare(`SELECT resolved, reason FROM review_queue WHERE doc_id = ?`)
      .get('E-other-still-open') as { resolved: number; reason: string };
    expect(other).toMatchObject({ resolved: 0, reason: 'agreement_cascade_unresolved' });

    const decisions = db.prepare(`SELECT doc_id, action, reason FROM ingestion_decisions`)
      .all() as Array<{ doc_id: string; action: string; reason: string }>;
    expect(decisions).toEqual(expect.arrayContaining([
      { doc_id: BONDI_EMPTY_DOC_ID, action: 'auto_resolved_empty', reason: 'executive_278e_no_transactions' },
      { doc_id: TRUMP_UNREADABLE_DOC_ID, action: 'rejected', reason: 'oge_text_unreadable' },
    ]));
    expect(decisions).toHaveLength(2);

    const second = await sweepKnownParkedExecutiveTerminals(env);
    expect(second).toEqual({ verifiedEmpty: 0, unreadable: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ingestion_decisions`).get()).toEqual({ n: 2 });
  });

  it('does not verified_empty a doc that already has a successful non-empty read or live rows', async () => {
    const db = await sqliteDatabase();
    seedReview(db, BONDI_EMPTY_DOC_ID, 'extract_empty_failure');
    seedReview(db, TRUMP_UNREADABLE_DOC_ID, 'agreement_cascade_unresolved');
    db.prepare(
      `INSERT INTO extraction_runs (doc_id, ok, row_count, result_json) VALUES (?, 1, 472, '[{}]')`,
    ).run(BONDI_EMPTY_DOC_ID);
    db.prepare(
      `INSERT INTO transactions (doc_id, source, deprecated_at) VALUES (?, 'primary', NULL)`,
    ).run(TRUMP_UNREADABLE_DOC_ID);

    const result = await sweepKnownParkedExecutiveTerminals(envFor(db));
    expect(result).toEqual({ verifiedEmpty: 0, unreadable: 0 });
    const bondi = db.prepare(`SELECT resolved, reason FROM review_queue WHERE doc_id = ?`)
      .get(BONDI_EMPTY_DOC_ID) as { resolved: number; reason: string };
    expect(bondi).toEqual({ resolved: 0, reason: 'extract_empty_failure' });
    const trump = db.prepare(`SELECT resolved FROM review_queue WHERE doc_id = ?`)
      .get(TRUMP_UNREADABLE_DOC_ID) as { resolved: number };
    expect(trump.resolved).toBe(0);
  });

  it('still verified_empties when the only successful reads are zero-row', async () => {
    const db = await sqliteDatabase();
    seedReview(db, BONDI_EMPTY_DOC_ID, 'extract_empty_failure,no_transactions_extracted');
    db.prepare(
      `INSERT INTO extraction_runs (doc_id, ok, row_count, result_json) VALUES (?, 1, 0, '[]')`,
    ).run(BONDI_EMPTY_DOC_ID);
    const closed = await closeVerifiedEmptyExecutive(envFor(db), BONDI_EMPTY_DOC_ID);
    expect(closed).toBe(true);
  });
});

describe('recoverExpiredCappedReviews', () => {
  it('does not rewrite empty-failure or unreadable rows into agreement_cascade_unresolved', async () => {
    const db = await sqliteDatabase();
    seedReview(db, 'E-empty', 'extract_empty_failure');
    seedReview(db, 'E-chrome', 'form_chrome_only,extract_empty_failure,no_transactions_extracted');
    seedReview(db, 'E-unread', 'ocr_unusable,oge_text_unreadable');
    seedReview(db, 'E-capped', 'needs_review');
    seedReview(db, 'E-already', 'agreement_cascade_unresolved');

    const out = await maybeRunAgreementAutopublish(envFor(db));
    expect(out).toMatchObject({ terminalized: 1, attempted: 0 });

    const reason = (docId: string) =>
      (db.prepare(`SELECT reason FROM review_queue WHERE doc_id = ?`).get(docId) as { reason: string }).reason;
    expect(reason('E-empty')).toBe('extract_empty_failure');
    expect(reason('E-chrome')).toBe('form_chrome_only,extract_empty_failure,no_transactions_extracted');
    expect(reason('E-unread')).toBe('ocr_unusable,oge_text_unreadable');
    expect(reason('E-already')).toBe('agreement_cascade_unresolved');
    expect(reason('E-capped')).toBe('agreement_cascade_unresolved');
  });
});
