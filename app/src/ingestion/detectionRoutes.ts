/**
 * src/ingestion/detectionRoutes.ts
 *
 * POST /api/ingest/detection — the residential scout (scout/congress-scout.mjs)
 * pushes each filing it detects the instant it appears on the primary gov source
 * (House Clerk / Senate eFD). Two durable side effects, both INGEST_TOKEN-gated:
 *
 *   1. Disclosure-latency candidate (congress_first_seen_at = detectedAt) so the
 *      admin latency summary can score "do we beat FMP, by how much".
 *   2. Official pipeline hand-off: INSERT OR IGNORE into filings + enqueue the
 *      same filing.new / ingestion_outbox path the cron watcher uses. This is
 *      what makes the residential Mac useful when Coolify/datacenter IPs get
 *      Imperva 403s from Senate eFD — detection stays on residential egress;
 *      storage/extraction stays on the Worker.
 *
 * Detection is existence + link, not extraction. Set `ingest: false` to record
 * latency only (used by pure measurement runs). Default is ingest when a
 * source URL is present.
 */
import { Hono } from 'hono';
import type { Env } from '../shared/types.ts';
import { resolveSecret } from '../secrets/infisical.ts';
import { constantTimeEqual } from '../auth/tokens.ts';
import { recordDisclosureLatencyCandidate } from './fmpDisclosureLatency.ts';
import {
  enqueueFilingNew,
  insertFilingIfNew,
  senateFilerId,
  type DiscoveredFiling,
  type InsertFilingResult,
} from './watcher.ts';

export function buildDetectionRouter(): Hono<{ Bindings: Env }> {
  const r = new Hono<{ Bindings: Env }>();

  r.post('/detection', async (c) => {
    const token = (await resolveSecret(c.env, 'INGEST_TOKEN')).value;
    if (!token || !(await constantTimeEqual(c.req.header('Authorization') ?? '', `Bearer ${token}`))) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const chamber = body.source === 'senate' ? 'senate' : body.source === 'house' ? 'house' : null;
    const docKey = typeof body.docKey === 'string' && body.docKey.trim() ? body.docKey.trim() : null;
    if (!chamber || !docKey) {
      return c.json({ error: "source ('house'|'senate') and docKey are required" }, 400);
    }
    const detectedAt =
      typeof body.detectedAt === 'string' && !Number.isNaN(Date.parse(body.detectedAt))
        ? new Date(body.detectedAt).toISOString()
        : new Date().toISOString();

    const filerName = typeof body.filerName === 'string' && body.filerName.trim()
      ? body.filerName.trim()
      : null;
    const sourceUrl = typeof body.link === 'string' ? body.link.trim() : '';

    const filing: DiscoveredFiling = {
      docId: docKey,
      chamber,
      sourceUrl,
      filedDate: typeof body.filedDate === 'string' ? body.filedDate : null,
      filerName,
      // Senate indexes carry no district; mint the same synthetic id the live
      // watcher uses so the filers row + feed attribution stay populated.
      filerId: chamber === 'senate' ? senateFilerId(filerName) : null,
    };

    // Default ON when a source URL is present so a residential scout push is
    // an official discovery, not just a latency stamp. Callers can set
    // `ingest: false` for pure measurement cycles.
    const wantIngest = body.ingest === true || (body.ingest !== false && Boolean(sourceUrl));

    let insert: InsertFilingResult | 'skipped' = 'skipped';
    let enqueued = false;
    if (wantIngest) {
      if (!sourceUrl) {
        return c.json({ error: 'link is required when ingest is enabled' }, 400);
      }
      try {
        insert = await insertFilingIfNew(c.env, filing, detectedAt);
      } catch (err) {
        return c.json({ error: (err as Error).message }, 500);
      }
      if (insert === 'deferred') {
        // Governor-capped; scout should retry on the next cycle (posted stays false).
        return c.json({ ok: false, error: 'deferred', reason: 'd1_write_governor', docKey, detectedAt }, 503);
      }
      if (insert === 'inserted') {
        try {
          enqueued = await enqueueFilingNew(c.env, filing);
        } catch (err) {
          // Row is durable in filings + outbox; enqueue failure is retried by
          // the scheduled outbox flush. Still stamp latency below.
          console.warn('detection enqueue failed', docKey, (err as Error).message);
        }
      }
    }

    try {
      await recordDisclosureLatencyCandidate(c.env, filing, detectedAt);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
    return c.json({ ok: true, docKey, detectedAt, insert, enqueued });
  });

  return r;
}
