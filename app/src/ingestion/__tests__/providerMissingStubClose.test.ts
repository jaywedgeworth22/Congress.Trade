import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'libsql';
import { d1Database } from '../../prices/__tests__/sqliteD1.ts';
import { runMigrations } from '../../admin/migrations.ts';
import type { Env } from '../../shared/types.ts';
import { routeProviderOnlyObservationsToReview, type DisclosureProviderRow } from '../tradeLatency.ts';
import {
  closeProviderMissingStubIfOfficialPersisted,
  enqueueOfficialSenateFromProviderObservation,
  reconcileProviderMissingStubsWithOfficial,
  findPersistedOfficialCounterpartForObservation,
  senateOfficialDocIdFromProvider,
} from '../providerMissingStubClose.ts';
import { sweepProviderOnlyReviewStubs } from '../autonomySweeps.ts';

const { notifySpy } = vi.hoisted(() => ({ notifySpy: vi.fn(async () => undefined) }));
vi.mock('../reviewQueueNotify.ts', () => ({ notifyReviewQueuePublisher: notifySpy }));

const SENATE_UUID = '51455bcd-4966-4e77-b481-09897ada81ae';
const OFFICIAL_SENATE_ID = `S-${SENATE_UUID}`;
const STUB_SENATE_ID = `provider-missing-fmp-senate-${SENATE_UUID}`;
const SOURCE_URL = `https://efdsearch.senate.gov/search/view/ptr/${SENATE_UUID}/`;

function senateObservation(over: Partial<DisclosureProviderRow> = {}): DisclosureProviderRow {
  return {
    provider: 'fmp',
    chamber: 'senate',
    providerKey: SENATE_UUID,
    tradeHash: 'tuberville_VEA_2025-11-21_sell',
    payload: { ticker: 'VEA', type: 'Sale' },
    sourceUrl: SOURCE_URL,
    filedDate: '2025-11-21',
    filerName: 'Tommy Tuberville',
    providerPublishedAt: '2026-08-25T10:00:00.000Z',
    ...over,
  };
}

describe('providerMissingStubClose', () => {
  let fileDb: Database.Database;
  let d1: ReturnType<typeof d1Database>;

  function makeEnv(): Env {
    return {
      DB: d1,
      INGEST_QUEUE: { send: async () => undefined, sendBatch: async () => undefined },
    } as unknown as Env;
  }

  beforeEach(async () => {
    fileDb = new Database(':memory:');
    d1 = d1Database(fileDb);
    await runMigrations(d1);
  });

  afterEach(() => {
    fileDb.close();
  });

  async function seedFiling(docId: string, ingestStatus: string, sourceUrl?: string | null) {
    await d1.prepare(
      `INSERT INTO filings (doc_id, chamber, ingest_status, filing_type, first_seen_at, source_url)
       VALUES (?, ?, ?, 'P', '2026-08-25T00:00:00.000Z', ?)`,
    ).bind(
      docId,
      docId.startsWith('S-') ? 'senate' : docId.startsWith('H-') ? 'house' : 'senate',
      ingestStatus,
      sourceUrl ?? null,
    ).run();
  }

  async function seedStubReview(stubDocId: string) {
    await seedFiling(stubDocId, 'needs_review');
    await d1.prepare(
      `INSERT INTO review_queue (doc_id, reason, payload, created_at, resolved, review_revision)
       VALUES (?, 'provider_discovered_missing_official', '{}', '2026-08-25T00:00:00.000Z', 0, 1)`,
    ).bind(stubDocId).run();
  }

  async function seedOfficialTx(docId: string) {
    await d1.prepare(
      `INSERT INTO transactions (id, doc_id, filer_id, tx_date, tx_type, source, owner, asset_name)
       VALUES (?, ?, 'senate-tuberville', '2025-11-21', 'S', 'primary', 'joint', 'VEA')`,
    ).bind(`tx-${docId}`, docId).run();
  }

  it('finds persisted Senate official by S-{providerKey}', async () => {
    await seedFiling(OFFICIAL_SENATE_ID, 'persisted', SOURCE_URL);
    const official = await findPersistedOfficialCounterpartForObservation(d1, senateObservation());
    expect(official).toBe(OFFICIAL_SENATE_ID);
  });

  it('does not treat in-pipeline official as persisted counterpart', async () => {
    await seedFiling(OFFICIAL_SENATE_ID, 'classified', SOURCE_URL);
    const official = await findPersistedOfficialCounterpartForObservation(d1, senateObservation());
    expect(official).toBeNull();
  });

  it('auto-rejects open provider-missing stub when official is persisted', async () => {
    await seedOfficialTx(OFFICIAL_SENATE_ID);
    await seedFiling(OFFICIAL_SENATE_ID, 'persisted', SOURCE_URL);
    await seedStubReview(STUB_SENATE_ID);

    const nowIso = '2026-08-25T12:00:00.000Z';
    const result = await closeProviderMissingStubIfOfficialPersisted(
      makeEnv(),
      senateObservation(),
      STUB_SENATE_ID,
      nowIso,
    );

    expect(result.closed).toBe(true);
    expect(result.officialDocId).toBe(OFFICIAL_SENATE_ID);

    const review = await d1.prepare(
      'SELECT resolved, resolution_kind, resolution_reason FROM review_queue WHERE doc_id = ?',
    ).bind(STUB_SENATE_ID).first<{
      resolved: number;
      resolution_kind: string;
      resolution_reason: string;
    }>();
    expect(review?.resolved).toBe(1);
    expect(review?.resolution_kind).toBe('rejected');
    expect(review?.resolution_reason).toContain(OFFICIAL_SENATE_ID);

    const stubFiling = await d1.prepare(
      'SELECT ingest_status FROM filings WHERE doc_id = ?',
    ).bind(STUB_SENATE_ID).first<{ ingest_status: string }>();
    expect(stubFiling?.ingest_status).toBe('error');

    const officialTxCount = await d1.prepare(
      'SELECT COUNT(*) AS n FROM transactions WHERE doc_id = ? AND deprecated_at IS NULL',
    ).bind(OFFICIAL_SENATE_ID).first<{ n: number }>();
    expect(officialTxCount?.n).toBe(1);

    const stubTxCount = await d1.prepare(
      'SELECT COUNT(*) AS n FROM transactions WHERE doc_id = ?',
    ).bind(STUB_SENATE_ID).first<{ n: number }>();
    expect(stubTxCount?.n).toBe(0);
  });

  it('reclassifies a stub the hourly sweep closed once the official filing persists', async () => {
    await seedStubReview(STUB_SENATE_ID);
    const swept = await sweepProviderOnlyReviewStubs(makeEnv());
    expect(swept.cleared).toBe(1);
    const sweptFiling = await d1.prepare(
      'SELECT ingest_status FROM filings WHERE doc_id = ?',
    ).bind(STUB_SENATE_ID).first<{ ingest_status: string }>();
    expect(sweptFiling?.ingest_status).toBe('verified_empty');

    await seedOfficialTx(OFFICIAL_SENATE_ID);
    await seedFiling(OFFICIAL_SENATE_ID, 'persisted', SOURCE_URL);

    const result = await closeProviderMissingStubIfOfficialPersisted(
      makeEnv(),
      senateObservation(),
      STUB_SENATE_ID,
      '2026-08-26T12:00:00.000Z',
    );
    expect(result.closed).toBe(true);
    expect(result.officialDocId).toBe(OFFICIAL_SENATE_ID);

    const review = await d1.prepare(
      'SELECT resolved, resolution_kind, resolution_reason FROM review_queue WHERE doc_id = ?',
    ).bind(STUB_SENATE_ID).first<{
      resolved: number;
      resolution_kind: string;
      resolution_reason: string;
    }>();
    expect(review?.resolved).toBe(1);
    expect(review?.resolution_kind).toBe('rejected');
    expect(review?.resolution_reason).toContain(OFFICIAL_SENATE_ID);

    const stubFiling = await d1.prepare(
      'SELECT ingest_status FROM filings WHERE doc_id = ?',
    ).bind(STUB_SENATE_ID).first<{ ingest_status: string }>();
    expect(stubFiling?.ingest_status).toBe('error');

    const again = await closeProviderMissingStubIfOfficialPersisted(
      makeEnv(),
      senateObservation(),
      STUB_SENATE_ID,
      '2026-08-26T13:00:00.000Z',
    );
    expect(again.closed).toBe(false);
  });

  it('does not override a stub resolution that did not come from the sweep', async () => {
    await seedFiling(STUB_SENATE_ID, 'verified_empty');
    await d1.prepare(
      `INSERT INTO review_queue (doc_id, reason, payload, created_at, resolved, resolution_kind, resolution_reason, review_revision)
       VALUES (?, 'provider_discovered_missing_official', '{}', '2026-08-25T00:00:00.000Z', 1, 'verified_empty', 'reviewer: checked by hand', 2)`,
    ).bind(STUB_SENATE_ID).run();
    await seedOfficialTx(OFFICIAL_SENATE_ID);
    await seedFiling(OFFICIAL_SENATE_ID, 'persisted', SOURCE_URL);

    const result = await closeProviderMissingStubIfOfficialPersisted(
      makeEnv(),
      senateObservation(),
      STUB_SENATE_ID,
      '2026-08-26T12:00:00.000Z',
    );
    expect(result.closed).toBe(false);
    const review = await d1.prepare(
      'SELECT resolution_kind, resolution_reason FROM review_queue WHERE doc_id = ?',
    ).bind(STUB_SENATE_ID).first<{ resolution_kind: string; resolution_reason: string }>();
    expect(review?.resolution_kind).toBe('verified_empty');
    expect(review?.resolution_reason).toBe('reviewer: checked by hand');
  });

  it('leaves stub pending when official is not persisted yet', async () => {
    await seedFiling(OFFICIAL_SENATE_ID, 'extracted', SOURCE_URL);
    await seedStubReview(STUB_SENATE_ID);

    const result = await closeProviderMissingStubIfOfficialPersisted(
      makeEnv(),
      senateObservation(),
      STUB_SENATE_ID,
      '2026-08-25T12:00:00.000Z',
    );

    expect(result.closed).toBe(false);
    expect(result.officialDocId).toBeUndefined();

    const review = await d1.prepare(
      'SELECT resolved FROM review_queue WHERE doc_id = ?',
    ).bind(STUB_SENATE_ID).first<{ resolved: number }>();
    expect(review?.resolved).toBe(0);

    const stubFiling = await d1.prepare(
      'SELECT ingest_status FROM filings WHERE doc_id = ?',
    ).bind(STUB_SENATE_ID).first<{ ingest_status: string }>();
    expect(stubFiling?.ingest_status).toBe('needs_review');
  });

  it('maps a Senate PTR UUID to S-{uuid} and ignores House / non-uuid keys', () => {
    expect(senateOfficialDocIdFromProvider(senateObservation())).toBe(OFFICIAL_SENATE_ID);
    expect(senateOfficialDocIdFromProvider(senateObservation({ chamber: 'house', providerKey: '2026-8221264' }))).toBeNull();
    expect(senateOfficialDocIdFromProvider(senateObservation({ providerKey: 'not-a-uuid' }))).toBeNull();
  });

  it('enqueues the official Senate PTR instead of waiting for a review stub', async () => {
    const nowIso = '2026-09-15T08:00:00.000Z';
    const official = await enqueueOfficialSenateFromProviderObservation(
      makeEnv(),
      senateObservation(),
      nowIso,
    );
    expect(official).toBe(OFFICIAL_SENATE_ID);

    const filing = await d1.prepare(
      'SELECT ingest_status, doc_kind, source_url FROM filings WHERE doc_id = ?',
    ).bind(OFFICIAL_SENATE_ID).first<{
      ingest_status: string;
      doc_kind: string | null;
      source_url: string | null;
    }>();
    expect(filing?.ingest_status).toBe('new');
    expect(filing?.doc_kind).toBe('senate_html');
    expect(filing?.source_url).toBe(SOURCE_URL);

    const outbox = await d1.prepare(
      'SELECT status FROM ingestion_outbox WHERE doc_id = ?',
    ).bind(OFFICIAL_SENATE_ID).first<{ status: string }>();
    expect(outbox?.status).toMatch(/pending|enqueued/);

    const again = await enqueueOfficialSenateFromProviderObservation(
      makeEnv(),
      senateObservation(),
      nowIso,
    );
    expect(again).toBe(OFFICIAL_SENATE_ID);
    const count = await d1.prepare(
      'SELECT COUNT(*) AS n FROM filings WHERE doc_id = ?',
    ).bind(OFFICIAL_SENATE_ID).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('creates a provider-only stub without waking the Publisher (review_queue.entered)', async () => {
    notifySpy.mockClear();
    const row: DisclosureProviderRow = {
      provider: 'fmp',
      chamber: 'house',
      providerKey: '20035492',
      tradeHash: 'h',
      payload: { ticker: 'VEA' },
      sourceUrl: null,
      filedDate: '2026-09-20',
      filerName: 'Example Member',
      providerPublishedAt: '2026-09-21T10:00:00.000Z',
    };

    await routeProviderOnlyObservationsToReview(makeEnv(), 'fmp', [row], '2026-09-21T12:00:00.000Z');

    const review = await d1.prepare('SELECT reason, resolved FROM review_queue WHERE doc_id = ?')
      .bind('provider-missing-fmp-house-20035492').first<{ reason: string; resolved: number }>();
    expect(review?.reason).toBe('provider_discovered_missing_official');
    expect(review?.resolved).toBe(0);
    expect(notifySpy).not.toHaveBeenCalled();
  });

  describe('reconcileProviderMissingStubsWithOfficial (official lands after provider row aged out)', () => {
    const NOW = new Date('2026-08-26T12:00:00.000Z');

    async function reviewState(docId: string) {
      return d1.prepare(
        'SELECT resolved, resolution_kind, resolution_reason FROM review_queue WHERE doc_id = ?',
      ).bind(docId).first<{ resolved: number; resolution_kind: string | null; resolution_reason: string | null }>();
    }

    async function filingStatus(docId: string) {
      const row = await d1.prepare('SELECT ingest_status FROM filings WHERE doc_id = ?')
        .bind(docId).first<{ ingest_status: string }>();
      return row?.ingest_status;
    }

    it('rejects a swept stub once its official filing persists, without a provider observation', async () => {
      await seedStubReview(STUB_SENATE_ID);
      expect((await sweepProviderOnlyReviewStubs(makeEnv())).cleared).toBe(1);
      expect(await filingStatus(STUB_SENATE_ID)).toBe('verified_empty');

      await seedOfficialTx(OFFICIAL_SENATE_ID);
      await seedFiling(OFFICIAL_SENATE_ID, 'persisted', SOURCE_URL);

      // payload is '{}' here, so the provider key comes from the stub doc_id.
      const result = await reconcileProviderMissingStubsWithOfficial(makeEnv(), { now: NOW });
      expect(result).toEqual({ scanned: 1, rejected: 1 });
      const review = await reviewState(STUB_SENATE_ID);
      expect(review?.resolution_kind).toBe('rejected');
      expect(review?.resolution_reason).toContain(OFFICIAL_SENATE_ID);
      expect(await filingStatus(STUB_SENATE_ID)).toBe('error');

      const again = await reconcileProviderMissingStubsWithOfficial(makeEnv(), { now: NOW });
      expect(again).toEqual({ scanned: 0, rejected: 0 });
    });

    it('rejects an open House stub using the provider key stored in its payload', async () => {
      const stub = 'provider-missing-fmp-house-20035492';
      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, ingest_status, filing_type, first_seen_at, source_url)
         VALUES (?, 'house', 'needs_review', 'P', '2026-08-25T00:00:00.000Z', NULL)`,
      ).bind(stub).run();
      await d1.prepare(
        `INSERT INTO review_queue (doc_id, reason, payload, created_at, resolved, review_revision)
         VALUES (?, 'provider_discovered_missing_official', ?, '2026-08-25T00:00:00.000Z', 0, 1)`,
      ).bind(stub, JSON.stringify({ reason: 'provider_discovered_missing_official', provider: 'fmp', providerKey: '20035492' })).run();
      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, ingest_status, filing_type, first_seen_at)
         VALUES ('H-2026-20035492', 'house', 'persisted', 'P', '2026-08-26T00:00:00.000Z')`,
      ).run();

      const result = await reconcileProviderMissingStubsWithOfficial(makeEnv(), { now: NOW });
      expect(result.rejected).toBe(1);
      const review = await reviewState(stub);
      expect(review?.resolution_kind).toBe('rejected');
      expect(review?.resolution_reason).toContain('H-2026-20035492');
    });

    it('leaves stubs alone when the official is not persisted, or a human resolved them', async () => {
      await seedStubReview(STUB_SENATE_ID);
      await seedFiling(OFFICIAL_SENATE_ID, 'extracted', SOURCE_URL);
      const pending = await reconcileProviderMissingStubsWithOfficial(makeEnv(), { now: NOW });
      expect(pending).toEqual({ scanned: 1, rejected: 0 });
      expect((await reviewState(STUB_SENATE_ID))?.resolved).toBe(0);

      await d1.prepare(
        `UPDATE review_queue SET resolved = 1, resolution_kind = 'verified_empty',
                resolution_reason = 'reviewer: checked by hand', resolved_at = CURRENT_TIMESTAMP
          WHERE doc_id = ?`,
      ).bind(STUB_SENATE_ID).run();
      await d1.prepare(`UPDATE filings SET ingest_status = 'persisted' WHERE doc_id = ?`)
        .bind(OFFICIAL_SENATE_ID).run();
      const human = await reconcileProviderMissingStubsWithOfficial(makeEnv(), { now: NOW });
      expect(human).toEqual({ scanned: 0, rejected: 0 });
      expect((await reviewState(STUB_SENATE_ID))?.resolution_reason).toBe('reviewer: checked by hand');
    });

    it('skips stubs older than the reconcile window', async () => {
      await seedStubReview(STUB_SENATE_ID);
      await seedOfficialTx(OFFICIAL_SENATE_ID);
      await seedFiling(OFFICIAL_SENATE_ID, 'persisted', SOURCE_URL);
      const result = await reconcileProviderMissingStubsWithOfficial(makeEnv(), {
        now: new Date('2027-06-01T00:00:00.000Z'),
      });
      expect(result).toEqual({ scanned: 0, rejected: 0 });
    });
  });
});
