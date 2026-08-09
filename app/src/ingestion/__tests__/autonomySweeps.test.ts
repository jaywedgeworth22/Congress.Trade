import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'libsql';
import { d1Database } from '../../prices/__tests__/sqliteD1.ts';
import { runMigrations } from '../../admin/migrations.ts';
import type { Env } from '../../shared/types.ts';

const fetchHouseIndex = vi.fn();
vi.mock('../houseSource.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../houseSource.ts')>();
  return {
    ...actual,
    fetchHouseIndex: (...args: unknown[]) => fetchHouseIndex(...args),
  };
});

// Mirrors extraction/__tests__/textPdf.test.ts's precedent: mock unpdf rather
// than hand-encoding a real PDF fixture, since only the text->date regex
// logic (extractPrintedDateFromText, tested directly below) is this module's
// own responsibility.
const unpdfMocks = vi.hoisted(() => ({
  getDocumentProxy: vi.fn(),
  extractText: vi.fn(),
}));
vi.mock('unpdf', () => ({
  getDocumentProxy: unpdfMocks.getDocumentProxy,
  extractText: unpdfMocks.extractText,
}));

import {
  sweepExtractionPendingLocalCeiling,
  sweepStrandedFilings,
  sweepFiledDateBackfill,
  sweepOgeUndatedFilingDates,
  extractPrintedDateFromText,
  runAutonomySweeps,
} from '../autonomySweeps.ts';

describe('autonomySweeps', () => {
  let fileDb: Database.Database;
  let d1: ReturnType<typeof d1Database>;
  let sentMessages: Array<{ message: unknown; options?: unknown }>;

  function makeEnv(): Env {
    return {
      DB: d1,
      RAW_FILES: { get: async () => null } as unknown,
      INGEST_QUEUE: { send: async (message: unknown, options?: unknown) => { sentMessages.push({ message, options }); } } as unknown,
    } as unknown as Env;
  }

  async function insertFiling(row: {
    doc_id: string;
    chamber?: string;
    ingest_status: string;
    doc_kind?: string;
    first_seen_at: string;
    local_wait_expires_at?: string | null;
    filed_date?: string | null;
    raw_object_key?: string | null;
  }) {
    await d1.prepare(
      `INSERT INTO filings (doc_id, chamber, ingest_status, doc_kind, first_seen_at, local_wait_expires_at, filed_date, raw_object_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      row.doc_id,
      row.chamber ?? 'house',
      row.ingest_status,
      row.doc_kind ?? 'unknown',
      row.first_seen_at,
      row.local_wait_expires_at ?? null,
      row.filed_date ?? null,
      row.raw_object_key ?? null,
    ).run();
  }

  async function markResolved(docId: string) {
    await d1.prepare(
      `INSERT INTO review_queue (doc_id, reason, resolved, created_at) VALUES (?, ?, 1, ?)`
    ).bind(docId, 'test-resolved', new Date().toISOString()).run();
  }

  beforeEach(async () => {
    fileDb = new Database(':memory:');
    d1 = d1Database(fileDb);
    sentMessages = [];
    fetchHouseIndex.mockReset();
    unpdfMocks.getDocumentProxy.mockReset();
    unpdfMocks.extractText.mockReset();
    await runMigrations(d1);
  });

  afterEach(() => {
    try { fileDb.close(); } catch {}
  });

  describe('sweepExtractionPendingLocalCeiling', () => {
    it('flips a filing past the 24h ceiling to classified and enqueues filing.extracted', async () => {
      const env = makeEnv();
      const now = new Date('2026-08-09T12:00:00Z');
      const wayPastExpiry = new Date(now.getTime() - 25 * 3600_000).toISOString(); // expired 25h ago
      await insertFiling({
        doc_id: 'doc-ceiling-1',
        ingest_status: 'extraction_pending_local',
        doc_kind: 'scanned_pdf',
        first_seen_at: wayPastExpiry,
        local_wait_expires_at: wayPastExpiry,
      });

      const result = await sweepExtractionPendingLocalCeiling(env, now);
      expect(result.flipped).toBe(1);

      const row = await d1.prepare(`SELECT ingest_status FROM filings WHERE doc_id = ?`)
        .bind('doc-ceiling-1').first<{ ingest_status: string }>();
      expect(row?.ingest_status).toBe('classified');
      expect(sentMessages).toEqual([{ message: { type: 'filing.extracted', docId: 'doc-ceiling-1' }, options: undefined }]);
    });

    it('does not touch a filing within the ceiling window', async () => {
      const env = makeEnv();
      const now = new Date('2026-08-09T12:00:00Z');
      const recentExpiry = new Date(now.getTime() - 60 * 60_000).toISOString(); // expired 1h ago
      await insertFiling({
        doc_id: 'doc-ceiling-2',
        ingest_status: 'extraction_pending_local',
        doc_kind: 'scanned_pdf',
        first_seen_at: recentExpiry,
        local_wait_expires_at: recentExpiry,
      });

      const result = await sweepExtractionPendingLocalCeiling(env, now);
      expect(result.flipped).toBe(0);
      const row = await d1.prepare(`SELECT ingest_status FROM filings WHERE doc_id = ?`)
        .bind('doc-ceiling-2').first<{ ingest_status: string }>();
      expect(row?.ingest_status).toBe('extraction_pending_local');
      expect(sentMessages).toEqual([]);
    });

    it('never revives an already review-resolved filing', async () => {
      const env = makeEnv();
      const now = new Date('2026-08-09T12:00:00Z');
      const wayPastExpiry = new Date(now.getTime() - 48 * 3600_000).toISOString();
      await insertFiling({
        doc_id: 'doc-ceiling-resolved',
        ingest_status: 'extraction_pending_local',
        doc_kind: 'scanned_pdf',
        first_seen_at: wayPastExpiry,
        local_wait_expires_at: wayPastExpiry,
      });
      await markResolved('doc-ceiling-resolved');

      const result = await sweepExtractionPendingLocalCeiling(env, now);
      expect(result.flipped).toBe(0);
      expect(sentMessages).toEqual([]);
    });
  });

  describe('sweepStrandedFilings', () => {
    it('terminalizes a filing stuck non-terminal past the 10-day ceiling', async () => {
      const env = makeEnv();
      const now = new Date('2026-08-09T12:00:00Z');
      const ancient = new Date(now.getTime() - 11 * 86_400_000).toISOString();
      await insertFiling({ doc_id: 'doc-stranded-1', ingest_status: 'new', first_seen_at: ancient });

      const result = await sweepStrandedFilings(env, now);
      expect(result.terminalized).toBe(1);
      const row = await d1.prepare(`SELECT ingest_status, error FROM filings WHERE doc_id = ?`)
        .bind('doc-stranded-1').first<{ ingest_status: string; error: string }>();
      expect(row?.ingest_status).toBe('error');
      expect(row?.error).toMatch(/autonomy-sweep/);
    });

    it('leaves a recently-stuck filing alone', async () => {
      const env = makeEnv();
      const now = new Date('2026-08-09T12:00:00Z');
      const recent = new Date(now.getTime() - 2 * 86_400_000).toISOString();
      await insertFiling({ doc_id: 'doc-stranded-recent', ingest_status: 'fetched', first_seen_at: recent });

      const result = await sweepStrandedFilings(env, now);
      expect(result.terminalized).toBe(0);
    });

    it('excludes provider-missing placeholder rows', async () => {
      const env = makeEnv();
      const now = new Date('2026-08-09T12:00:00Z');
      const ancient = new Date(now.getTime() - 30 * 86_400_000).toISOString();
      await insertFiling({ doc_id: 'provider-missing-uw-senate-abc', ingest_status: 'new', first_seen_at: ancient });

      const result = await sweepStrandedFilings(env, now);
      expect(result.terminalized).toBe(0);
      const row = await d1.prepare(`SELECT ingest_status FROM filings WHERE doc_id = ?`)
        .bind('provider-missing-uw-senate-abc').first<{ ingest_status: string }>();
      expect(row?.ingest_status).toBe('new');
    });

    it('never revives an already review-resolved filing', async () => {
      const env = makeEnv();
      const now = new Date('2026-08-09T12:00:00Z');
      const ancient = new Date(now.getTime() - 30 * 86_400_000).toISOString();
      await insertFiling({ doc_id: 'doc-stranded-resolved', ingest_status: 'classified', first_seen_at: ancient });
      await markResolved('doc-stranded-resolved');

      const result = await sweepStrandedFilings(env, now);
      expect(result.terminalized).toBe(0);
    });
  });

  describe('sweepFiledDateBackfill', () => {
    it('backfills filed_date for a stale House filing from the bulk index', async () => {
      const env = makeEnv();
      const now = new Date('2026-08-09T12:00:00Z');
      const stale = new Date(now.getTime() - 100 * 3600_000).toISOString(); // >72h
      await insertFiling({ doc_id: 'H-2026-20012345', chamber: 'house', ingest_status: 'classified', first_seen_at: stale, filed_date: null });
      fetchHouseIndex.mockResolvedValueOnce([
        { docId: '20012345', filingType: 'P', year: '2026', first: 'Jane', last: 'Smith', stateDst: 'CA01', filingDate: '7/1/2026', isPtr: true, pipelineDocId: 'H-2026-20012345', sourceUrl: 'https://x' },
      ]);

      const result = await sweepFiledDateBackfill(env, now);
      expect(result.updated).toBe(1);
      expect(result.yearsFetched).toEqual(['2026']);
      expect(fetchHouseIndex).toHaveBeenCalledTimes(1);
      expect(fetchHouseIndex.mock.calls[0][0]).toBe('2026');

      const row = await d1.prepare(`SELECT filed_date FROM filings WHERE doc_id = ?`)
        .bind('H-2026-20012345').first<{ filed_date: string }>();
      expect(row?.filed_date).toBe('7/1/2026');
    });

    it('never overwrites an already-set filed_date', async () => {
      const env = makeEnv();
      const now = new Date('2026-08-09T12:00:00Z');
      const stale = new Date(now.getTime() - 100 * 3600_000).toISOString();
      // filed_date is NOT NULL, so this row is not even selected as "stuck".
      await insertFiling({ doc_id: 'H-2026-20099999', chamber: 'house', ingest_status: 'classified', first_seen_at: stale, filed_date: '2026-06-01' });

      const result = await sweepFiledDateBackfill(env, now);
      expect(result.updated).toBe(0);
      expect(fetchHouseIndex).not.toHaveBeenCalled();
    });

    it('is a no-op within the 72h freshness window', async () => {
      const env = makeEnv();
      const now = new Date('2026-08-09T12:00:00Z');
      const fresh = new Date(now.getTime() - 10 * 3600_000).toISOString();
      await insertFiling({ doc_id: 'H-2026-20055555', chamber: 'house', ingest_status: 'classified', first_seen_at: fresh, filed_date: null });

      const result = await sweepFiledDateBackfill(env, now);
      expect(result.updated).toBe(0);
      expect(fetchHouseIndex).not.toHaveBeenCalled();
    });
  });

  describe('extractPrintedDateFromText (pure)', () => {
    const now = new Date('2026-08-09T12:00:00Z');

    it('prefers a date next to a report/signature-date label', () => {
      const text = 'Some preamble text.\nDate of Report: 3/14/2026\nSignature Date: 3/15/2026\nfooter';
      // Last labeled match wins (signature date is typically the operative one).
      expect(extractPrintedDateFromText(text, now)).toBe('2026-03-15');
    });

    it('falls back to the last plausible bare date when no label is present', () => {
      const text = 'Filed by the officer on 1/2/2026 pursuant to the Act, page stamped 4/5/2026';
      expect(extractPrintedDateFromText(text, now)).toBe('2026-04-05');
    });

    it('returns null when no plausible date exists', () => {
      expect(extractPrintedDateFromText('no dates anywhere in this text', now)).toBeNull();
    });

    it('rejects implausible dates (too old / in the future)', () => {
      expect(extractPrintedDateFromText('signed 1/1/1999', now)).toBeNull();
      expect(extractPrintedDateFromText('signed 1/1/2099', now)).toBeNull();
    });
  });

  describe('sweepOgeUndatedFilingDates', () => {
    it('backfills filed_date from the extracted PDF text for an E-undated- doc', async () => {
      const now = new Date('2026-08-09T12:00:00Z');
      await insertFiling({
        doc_id: 'E-undated-jane-q-official',
        chamber: 'executive',
        ingest_status: 'classified',
        doc_kind: 'text_pdf',
        first_seen_at: now.toISOString(),
        raw_object_key: 'raw/E-undated-jane-q-official',
      });
      const pdfBytes = new Uint8Array([1, 2, 3]);
      const env: Env = {
        DB: d1,
        RAW_FILES: {
          get: async (key: string) =>
            key === 'raw/E-undated-jane-q-official'
              ? { arrayBuffer: async () => pdfBytes.buffer }
              : null,
        } as unknown,
        INGEST_QUEUE: { send: async () => {} } as unknown,
      } as unknown as Env;
      const destroy = vi.fn();
      unpdfMocks.getDocumentProxy.mockResolvedValue({ numPages: 1, destroy });
      unpdfMocks.extractText.mockResolvedValue({ text: 'Report Date: 5/1/2026\nSignature Date: 5/2/2026' });

      const result = await sweepOgeUndatedFilingDates(env);
      expect(result.attempted).toBe(1);
      expect(result.updated).toBe(1);
      expect(destroy).toHaveBeenCalledTimes(1);

      const row = await d1.prepare(`SELECT filed_date FROM filings WHERE doc_id = ?`)
        .bind('E-undated-jane-q-official').first<{ filed_date: string }>();
      expect(row?.filed_date).toBe('2026-05-02');
    });

    it('is a safe no-op when the R2 object is missing (never throws)', async () => {
      const now = new Date('2026-08-09T12:00:00Z');
      await insertFiling({
        doc_id: 'E-undated-missing-object',
        chamber: 'executive',
        ingest_status: 'classified',
        doc_kind: 'text_pdf',
        first_seen_at: now.toISOString(),
        raw_object_key: 'raw/E-undated-missing-object',
      });
      const env: Env = {
        DB: d1,
        RAW_FILES: { get: async () => null } as unknown,
        INGEST_QUEUE: { send: async () => {} } as unknown,
      } as unknown as Env;

      const result = await sweepOgeUndatedFilingDates(env);
      expect(result.attempted).toBe(1);
      expect(result.updated).toBe(0);
    });

    it('leaves filed_date untouched when no plausible date is found in the text', async () => {
      const now = new Date('2026-08-09T12:00:00Z');
      await insertFiling({
        doc_id: 'E-undated-no-date',
        chamber: 'executive',
        ingest_status: 'classified',
        doc_kind: 'text_pdf',
        first_seen_at: now.toISOString(),
        raw_object_key: 'raw/E-undated-no-date',
      });
      const env: Env = {
        DB: d1,
        RAW_FILES: { get: async () => ({ arrayBuffer: async () => new Uint8Array([1]).buffer }) } as unknown,
        INGEST_QUEUE: { send: async () => {} } as unknown,
      } as unknown as Env;
      unpdfMocks.getDocumentProxy.mockResolvedValue({ numPages: 1 });
      unpdfMocks.extractText.mockResolvedValue({ text: 'no usable date anywhere' });

      const result = await sweepOgeUndatedFilingDates(env);
      expect(result.attempted).toBe(1);
      expect(result.updated).toBe(0);
    });

    it('ignores filings outside the E-undated- prefix', async () => {
      const now = new Date('2026-08-09T12:00:00Z');
      await insertFiling({
        doc_id: 'E-2026-jane-q-official',
        chamber: 'executive',
        ingest_status: 'classified',
        doc_kind: 'text_pdf',
        first_seen_at: now.toISOString(),
        raw_object_key: 'raw/E-2026-jane-q-official',
      });
      const env = makeEnv();
      const result = await sweepOgeUndatedFilingDates(env);
      expect(result.attempted).toBe(0);
    });
  });

  describe('runAutonomySweeps orchestration', () => {
    it('isolates a failing sweep so the others still run', async () => {
      const env = makeEnv();
      const now = new Date('2026-08-09T12:00:00Z');
      const wayPastExpiry = new Date(now.getTime() - 25 * 3600_000).toISOString();
      await insertFiling({
        doc_id: 'doc-orchestration-1',
        ingest_status: 'extraction_pending_local',
        doc_kind: 'scanned_pdf',
        first_seen_at: wayPastExpiry,
        local_wait_expires_at: wayPastExpiry,
      });
      // Force the filed-date backfill lane to blow up.
      fetchHouseIndex.mockRejectedValueOnce(new Error('network down'));
      await insertFiling({
        doc_id: 'H-2026-20077777',
        chamber: 'house',
        ingest_status: 'classified',
        first_seen_at: new Date(now.getTime() - 100 * 3600_000).toISOString(),
        filed_date: null,
      });

      const result = await runAutonomySweeps(env, now);
      // The ceiling sweep still ran and did its job...
      expect(result.ceiling?.flipped).toBe(1);
      // ...even though the filed-date fetch itself failed inside its own
      // sweep (caught internally, not surfaced as a top-level error) — the
      // orchestrator's error isolation is for a sweep throwing outright.
      expect(result.errors).toEqual([]);
    });
  });
});
