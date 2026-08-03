import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'libsql';
import { d1Database } from '../../prices/__tests__/sqliteD1.ts';
import { runMigrations } from '../../admin/migrations.ts';
import { isLocalWorkerHeartbeatFresh, classifyFiling } from '../classifier.ts';
import { handleLocalWaitCheck } from '../../queueHandlers.ts';
import { createAdminApp } from '../../admin/routes.ts';
import type { Env, Filing } from '../../shared/types.ts';

describe('Local Vision Worker & Bounded Wait State (M1 / R1)', () => {
  let fileDb: Database.Database;
  let d1: ReturnType<typeof d1Database>;
  let sentMessages: Array<{ message: unknown; options?: unknown }> = [];

  const mockR2 = {
    get: async (key: string) => {
      if (key === 'scanned.pdf') {
        const bytes = new TextEncoder().encode('%PDF-1.7\n/Subtype /Image /Width 2000 /Height 2600');
        return {
          httpMetadata: { contentType: 'application/pdf' },
          arrayBuffer: async () => bytes.buffer,
        };
      }
      if (key === 'text.pdf') {
        const bytes = new TextEncoder().encode('%PDF-1.7\n/Font <</F1 1 0 R>> BT (x) Tj ET');
        return {
          httpMetadata: { contentType: 'application/pdf' },
          arrayBuffer: async () => bytes.buffer,
        };
      }
      return null;
    },
  };

  const mockIngestQueue = {
    send: async (message: unknown, options?: unknown) => {
      sentMessages.push({ message, options });
    },
  };

  function makeEnv(): Env {
    return {
      DB: d1,
      RAW_FILES: mockR2 as unknown,
      INGEST_QUEUE: mockIngestQueue as unknown,
      ADMIN_OPEN_IN_DEV: 'true',
      ADMIN_TOKEN: 'test-admin-token',
    } as unknown as Env;
  }

  beforeEach(async () => {
    fileDb = new Database(':memory:');
    d1 = d1Database(fileDb);
    sentMessages = [];
    await runMigrations(d1);
  });

  afterEach(() => {
    try {
      fileDb.close();
    } catch {}
  });

  describe('isLocalWorkerHeartbeatFresh', () => {
    it('returns false when no heartbeat exists', async () => {
      const fresh = await isLocalWorkerHeartbeatFresh(d1);
      expect(fresh).toBe(false);
    });

    it('returns true when a heartbeat exists within 5 minutes', async () => {
      const nowIso = new Date().toISOString();
      await d1.prepare(
        `INSERT INTO local_worker_heartbeat (worker_id, last_heartbeat_at, status_json) VALUES (?, ?, ?)`
      ).bind('local_mac_1', nowIso, JSON.stringify({ ok: true })).run();

      const fresh = await isLocalWorkerHeartbeatFresh(d1);
      expect(fresh).toBe(true);
    });

    it('returns false when heartbeat is older than 5 minutes', async () => {
      const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      await d1.prepare(
        `INSERT INTO local_worker_heartbeat (worker_id, last_heartbeat_at, status_json) VALUES (?, ?, ?)`
      ).bind('local_mac_1', oldTime, JSON.stringify({ ok: true })).run();

      const fresh = await isLocalWorkerHeartbeatFresh(d1);
      expect(fresh).toBe(false);
    });
  });

  describe('classifyFiling bounded wait state', () => {
    it('sets status to extraction_pending_local and enqueues delayed check when worker is fresh', async () => {
      const env = makeEnv();
      const nowIso = new Date().toISOString();
      await d1.prepare(
        `INSERT INTO local_worker_heartbeat (worker_id, last_heartbeat_at, status_json) VALUES (?, ?, ?)`
      ).bind('local_mac_1', nowIso, '{}').run();

      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, source_url, raw_object_key, ingest_status, doc_kind, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind('doc-scan-1', 'house', 'https://example.com/scan.pdf', 'scanned.pdf', 'fetched', 'unknown', nowIso).run();

      const docKind = await classifyFiling(env, 'doc-scan-1');
      expect(docKind).toBe('scanned_pdf');

      const filingRow = await d1.prepare(
        `SELECT ingest_status, local_wait_expires_at FROM filings WHERE doc_id = ?`
      ).bind('doc-scan-1').first<{ ingest_status: string; local_wait_expires_at: string }>();

      expect(filingRow?.ingest_status).toBe('extraction_pending_local');
      expect(filingRow?.local_wait_expires_at).toBeDefined();

      expect(sentMessages.length).toBe(1);
      expect(sentMessages[0].message).toEqual({ type: 'filing.local_wait_check', docId: 'doc-scan-1' });
      expect(sentMessages[0].options).toEqual({ delaySeconds: 900 });
    });

    it('sets status to classified and enqueues filing.extracted immediately when worker is offline/stale', async () => {
      const env = makeEnv();
      const nowIso = new Date().toISOString();

      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, source_url, raw_object_key, ingest_status, doc_kind, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind('doc-scan-stale', 'house', 'https://example.com/scan.pdf', 'scanned.pdf', 'fetched', 'unknown', nowIso).run();

      const docKind = await classifyFiling(env, 'doc-scan-stale');
      expect(docKind).toBe('scanned_pdf');

      const filingRow = await d1.prepare(
        `SELECT ingest_status, local_wait_expires_at FROM filings WHERE doc_id = ?`
      ).bind('doc-scan-stale').first<{ ingest_status: string; local_wait_expires_at: string | null }>();

      expect(filingRow?.ingest_status).toBe('classified');
      expect(filingRow?.local_wait_expires_at).toBeNull();

      expect(sentMessages.length).toBe(1);
      expect(sentMessages[0].message).toEqual({ type: 'filing.extracted', docId: 'doc-scan-stale' });
    });
  });

  describe('handleLocalWaitCheck queue handler', () => {
    it('transitions expired extraction_pending_local filing to classified and enqueues filing.extracted', async () => {
      const env = makeEnv();
      const pastExpires = new Date(Date.now() - 60 * 1000).toISOString();
      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, source_url, ingest_status, doc_kind, local_wait_expires_at, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind('doc-wait-expired', 'house', 'https://example.com/a.pdf', 'extraction_pending_local', 'scanned_pdf', pastExpires, new Date().toISOString()).run();

      await handleLocalWaitCheck(env, 'doc-wait-expired');

      const row = await d1.prepare(
        `SELECT ingest_status FROM filings WHERE doc_id = ?`
      ).bind('doc-wait-expired').first<{ ingest_status: string }>();

      expect(row?.ingest_status).toBe('classified');
      expect(sentMessages.length).toBe(1);
      expect(sentMessages[0].message).toEqual({ type: 'filing.extracted', docId: 'doc-wait-expired' });
    });

    it('does not transition non-expired extraction_pending_local filing', async () => {
      const env = makeEnv();
      const futureExpires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, source_url, ingest_status, doc_kind, local_wait_expires_at, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind('doc-wait-active', 'house', 'https://example.com/a.pdf', 'extraction_pending_local', 'scanned_pdf', futureExpires, new Date().toISOString()).run();

      await handleLocalWaitCheck(env, 'doc-wait-active');

      const row = await d1.prepare(
        `SELECT ingest_status FROM filings WHERE doc_id = ?`
      ).bind('doc-wait-active').first<{ ingest_status: string }>();

      expect(row?.ingest_status).toBe('extraction_pending_local');
      expect(sentMessages.length).toBe(0);
    });
  });

  describe('Admin Endpoints for Local Vision Worker', () => {
    it('POST /api/admin/local-worker/heartbeat updates worker heartbeat', async () => {
      const app = createAdminApp();
      const env = makeEnv();

      const res = await app.request('/local-worker/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin-token' },
        body: JSON.stringify({ workerId: 'mac_studio_1', statusJson: { cpu: '10%' } }),
      }, env as never);

      expect(res.status).toBe(200);
      const json = await res.json() as { ok: boolean; workerId: string };
      expect(json.ok).toBe(true);
      expect(json.workerId).toBe('mac_studio_1');

      const fresh = await isLocalWorkerHeartbeatFresh(d1);
      expect(fresh).toBe(true);
    });

    it('GET /api/admin/scanned-filings/pending returns pending scanned filings', async () => {
      const app = createAdminApp();
      const env = makeEnv();
      const nowIso = new Date().toISOString();

      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, source_url, ingest_status, doc_kind, local_wait_expires_at, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind('scanned-pending-1', 'house', 'https://example.com/1.pdf', 'extraction_pending_local', 'scanned_pdf', new Date(Date.now() + 600000).toISOString(), nowIso).run();

      const res = await app.request('/scanned-filings/pending', {
        method: 'GET',
        headers: { Authorization: 'Bearer test-admin-token' },
      }, env as never);

      expect(res.status).toBe(200);
      const json = await res.json() as { ok: boolean; count: number; filings: Array<{ doc_id: string }> };
      expect(json.ok).toBe(true);
      expect(json.count).toBe(1);
      expect(json.filings[0].doc_id).toBe('scanned-pending-1');
    });

    it('POST /api/admin/ingest-local-vision normalizes and persists transactions with source=local_mac', async () => {
      const app = createAdminApp();
      const env = makeEnv();
      const nowIso = new Date().toISOString();

      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, filing_type, filed_date, source_url, ingest_status, doc_kind, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind('doc-local-vision-1', 'house', 'P', '2026-08-01', 'https://example.com/scan.pdf', 'extraction_pending_local', 'scanned_pdf', nowIso).run();

      const transactions = [
        {
          ticker: 'NVDA',
          assetName: 'NVIDIA Corporation',
          txType: 'P',
          txDate: '2026-07-25',
          amountMin: 1001,
          amountMax: 15000,
          confidence: 0.95,
          rawText: 'NVIDIA Corporation [NVDA] P 07/25/2026 $1,001 - $15,000',
        },
      ];

      const res = await app.request('/ingest-local-vision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin-token' },
        body: JSON.stringify({
          docId: 'doc-local-vision-1',
          transactions,
          workerId: 'mac_vision_worker_1',
          extractor: 'mac_vision_v1',
        }),
      }, env as never);

      expect(res.status).toBe(200);

      const json = await res.json() as { ok: boolean; docId: string; published: boolean; txCount: number };
      expect(json.ok).toBe(true);
      expect(json.docId).toBe('doc-local-vision-1');
      expect(json.published).toBe(true);
      expect(json.txCount).toBe(1);

      const txRow = await d1.prepare(
        `SELECT doc_id, ticker, source FROM transactions WHERE doc_id = ?`
      ).bind('doc-local-vision-1').first<{ doc_id: string; ticker: string; source: string }>();

      expect(txRow?.ticker).toBe('NVDA');
      expect(txRow?.source).toBe('local_mac');

      const filingRow = await d1.prepare(
        `SELECT ingest_status FROM filings WHERE doc_id = ?`
      ).bind('doc-local-vision-1').first<{ ingest_status: string }>();

      expect(filingRow?.ingest_status).toBe('persisted');
    });
  });
});
