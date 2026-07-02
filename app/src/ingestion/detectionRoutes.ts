/**
 * src/ingestion/detectionRoutes.ts
 *
 * POST /api/ingest/detection — the residential scout (scout/congress-scout.mjs)
 * pushes each filing it detects the instant it appears on the primary gov source
 * (House Clerk / Senate eFD), stamping OUR first-seen time. We record it as a
 * disclosure-latency candidate (congress_first_seen_at = detectedAt); the cron
 * FMP latency probe then matches it against FMP's first-seen, and the admin
 * latency summary shows the per-filing lead (fmp_first_seen − our_detected) —
 * the "do we beat FMP, by how much" number, persisted server-side.
 *
 * Detection only: existence + link, not extraction. INGEST_TOKEN-gated (same
 * bearer secret as the securities import).
 */
import { Hono } from 'hono';
import type { Env } from '../shared/types';
import { resolveSecret } from '../secrets/infisical';
import { constantTimeEqual } from '../auth/tokens';
import { recordDisclosureLatencyCandidate } from './fmpDisclosureLatency';
import type { DiscoveredFiling } from './watcher';

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

    const filing: DiscoveredFiling = {
      docId: docKey,
      chamber,
      sourceUrl: typeof body.link === 'string' ? body.link : '',
      filedDate: typeof body.filedDate === 'string' ? body.filedDate : null,
      filerName: typeof body.filerName === 'string' ? body.filerName : null,
    };

    try {
      await recordDisclosureLatencyCandidate(c.env, filing, detectedAt);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
    return c.json({ ok: true, docKey, detectedAt });
  });

  return r;
}
