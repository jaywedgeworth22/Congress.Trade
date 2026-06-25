/**
 * src/export/routes.ts
 * OWNER: export
 *
 * Bulk export API mounted under /api/export. Lets a sibling app (App B) pull the
 * full market-data tables as a date-partitioned NDJSON snapshot, instead of
 * paging the per-ticker REST endpoints, for first-time bootstrapping or catch-up
 * after a downtime gap.
 *
 * Auth: the scoped INGEST_TOKEN bearer (the same token that unlocks
 * POST /api/admin/securities/import) — so bulk access is granted to App B
 * without handing out the full ADMIN_TOKEN.
 *
 * Two endpoints:
 *   GET /api/export/bulk-snapshot            → the manifest (object keys, row
 *                                              counts, schema, per-table
 *                                              downloadPath). Generates today's
 *                                              snapshot inline if the cron hasn't
 *                                              written it yet.
 *   GET /api/export/bulk-snapshot/file       → streams one table's NDJSON straight
 *                                              from R2 (token-gated).
 *
 * NOTE on downloads: the R2 *binding* in the Workers runtime has no presigned-URL
 * method, so rather than returning S3-style signed links we expose a token-gated
 * streaming download path. App B fetches each file with the same INGEST_TOKEN.
 */

import { Hono } from 'hono';
import type { Env } from '../shared/types';
import { constantTimeEqual } from '../auth/tokens';
import {
  runBulkSnapshot,
  readManifest,
  snapshotObjectKey,
  SNAPSHOT_TABLES,
  type SnapshotManifest,
  type SnapshotTableName,
} from './snapshot';

/** Env augmented with the scoped cross-app ingest token (mirrors admin/routes). */
type ExportEnv = Env & { INGEST_TOKEN?: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RUN_ID_RE = /^[A-Za-z0-9-]{1,64}$/; // crypto.randomUUID() shape (hex + dashes)
const VALID_TABLES = new Set<string>(SNAPSHOT_TABLES.map((t) => t.name));

function todayUtc(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** True when the request carries a valid `Bearer <INGEST_TOKEN>` header. */
async function isAuthorized(env: ExportEnv, authorization?: string): Promise<boolean> {
  const token = env.INGEST_TOKEN;
  if (!token) return false; // closed by default when the token isn't configured
  return constantTimeEqual(authorization ?? '', `Bearer ${token}`);
}

/** Parse + validate the optional ?tables= filter. Returns null on an invalid name. */
function parseTables(raw: string | undefined): SnapshotTableName[] | null {
  if (!raw) return SNAPSHOT_TABLES.map((t) => t.name);
  const wanted = raw.split(',').map((s) => s.trim()).filter(Boolean);
  for (const t of wanted) if (!VALID_TABLES.has(t)) return null;
  return wanted as SnapshotTableName[];
}

/** Narrow a full manifest to the requested tables and attach download paths. */
function shapeManifest(manifest: SnapshotManifest, tables: SnapshotTableName[]): Record<string, unknown> {
  const outTables: Record<string, unknown> = {};
  const outSchema: Record<string, string[]> = {};
  for (const name of tables) {
    const info = manifest.tables[name];
    if (!info) continue;
    outTables[name] = {
      ...info,
      // downloadPath pins the runId so a client that read THIS manifest always
      // downloads THIS run's files, even if a later same-day run republishes.
      downloadPath: `/api/export/bulk-snapshot/file?date=${manifest.snapshotDate}&runId=${manifest.runId}&table=${name}`,
    };
    if (manifest.schema[name]) outSchema[name] = manifest.schema[name];
  }
  return {
    generatedAt: manifest.generatedAt,
    snapshotDate: manifest.snapshotDate,
    runId: manifest.runId,
    format: manifest.format,
    tables: outTables,
    schema: outSchema,
  };
}

export function buildExportRouter(): Hono<{ Bindings: ExportEnv }> {
  const r = new Hono<{ Bindings: ExportEnv }>();

  // --- GET /bulk-snapshot -------------------------------------------------
  r.get('/bulk-snapshot', async (c) => {
    if (!(await isAuthorized(c.env, c.req.header('authorization')))) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    const q = c.req.query();
    if (q.format && q.format !== 'ndjson') {
      return c.json({ error: 'unsupported format; only ndjson is available', format: q.format }, 400);
    }
    const tables = parseTables(q.tables);
    if (!tables) return c.json({ error: 'unknown table in ?tables=' }, 400);

    const today = todayUtc();
    const date = q.date ?? today;
    if (!DATE_RE.test(date)) return c.json({ error: 'date must be YYYY-MM-DD', date }, 400);
    if (date > today) return c.json({ error: 'snapshot cannot exist for a future date', date }, 400);

    // Return the cron-written manifest if present; otherwise generate today's
    // snapshot inline (back-fill path). A missing past-date snapshot is a 404 —
    // we don't retroactively reconstruct historical days.
    let manifest = await readManifest(c.env, date);
    if (!manifest) {
      if (date !== today) {
        return c.json({ error: 'snapshot not available for date', date }, 404);
      }
      manifest = await runBulkSnapshot(c.env, date);
    }
    return c.json(shapeManifest(manifest, tables));
  });

  // --- GET /bulk-snapshot/file -------------------------------------------
  // Token-gated streaming download of one table's NDJSON object from R2.
  r.get('/bulk-snapshot/file', async (c) => {
    if (!(await isAuthorized(c.env, c.req.header('authorization')))) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const q = c.req.query();
    const date = q.date ?? '';
    const table = q.table ?? '';
    const runId = q.runId ?? '';
    if (!DATE_RE.test(date)) return c.json({ error: 'date must be YYYY-MM-DD', date }, 400);
    if (!VALID_TABLES.has(table)) return c.json({ error: 'unknown table', table }, 400);
    if (!RUN_ID_RE.test(runId)) return c.json({ error: 'runId required (from the manifest downloadPath)', runId }, 400);

    // Serve the EXACT run named in the manifest the client read (the runId is
    // pinned in downloadPath). Old runs aren't deleted, so a client that fetched
    // run A's manifest keeps downloading run A's files even after a later run B
    // republishes — consistent row counts ↔ bytes.
    const obj = await c.env.RAW_FILES.get(snapshotObjectKey(date, runId, table));
    if (!obj) return c.json({ error: 'snapshot file not available', date, runId, table }, 404);
    return new Response(obj.body, {
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'content-disposition': `attachment; filename="${table}-${date}.ndjson"`,
        'cache-control': 'private, max-age=3600',
      },
    });
  });

  return r;
}
