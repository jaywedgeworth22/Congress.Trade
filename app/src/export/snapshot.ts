/**
 * src/export/snapshot.ts
 * OWNER: export
 *
 * Daily bulk snapshot writer: dumps the market-data tables App B bootstraps from
 * (prices, S&P, securities reference, fundamentals, analyst consensus) to R2 as
 * NDJSON — one JSON object per line — under a date-partitioned key prefix, plus
 * a manifest written LAST so a partially-written run is invisible to readers.
 *
 * Why NDJSON: every column value survives unchanged with no CSV quoting ceremony,
 * the keys are self-describing, and App B can stream-parse line by line without
 * loading the whole file. Parquet is not viable in the Workers runtime (no native
 * encoder, and a WASM one would blow the Worker size budget).
 *
 * Why paged + multipart: a single `SELECT *` on price_eod can exceed D1's result
 * cap and the whole file can exceed Worker memory, so each table is paged in
 * bounded chunks and streamed to R2 via multipart upload (small tables fall back
 * to a single PUT). Memory stays bounded to ~one part + one page.
 *
 * The congressional-trade corpus (transactions/filings/filers) is deliberately
 * NOT exported here — it is already served by the cursor-paged /api/transactions
 * feed; duplicating it would create a second source of truth. Likewise insider /
 * short-volume streams flow App B → App A, so echoing them back is out of scope.
 */

import type { Env } from '../shared/types';
import { all } from '../shared/db';

/** Tables included in the snapshot, with a stable ORDER BY for paged reads. */
export const SNAPSHOT_TABLES = [
  { name: 'price_eod', orderBy: 'ticker ASC, date ASC' },
  { name: 'spx_eod', orderBy: 'date ASC' },
  { name: 'securities_ref', orderBy: 'ticker ASC' },
  { name: 'fundamentals_eod', orderBy: 'ticker ASC, date ASC' },
  { name: 'analyst_consensus', orderBy: 'ticker ASC, date ASC' },
] as const;

export type SnapshotTableName = (typeof SNAPSHOT_TABLES)[number]['name'];

/** Documented column set per table (mirrors the migrations). Self-describing in
 *  the NDJSON itself; surfaced in the manifest so App B can map without guessing. */
export const SNAPSHOT_SCHEMA: Record<SnapshotTableName, string[]> = {
  price_eod: ['ticker', 'date', 'close', 'volume'],
  spx_eod: ['date', 'close'],
  securities_ref: [
    'ticker', 'company_name', 'sector', 'industry', 'asset_class', 'is_etf', 'is_adr',
    'country', 'state_hq', 'state_of_incorp', 'exchange', 'exchange_short', 'currency',
    'market_cap', 'market_cap_bucket', 'ipo_date', 'cik', 'sic_code', 'sic_description',
    'source', 'enriched_at', 'enrichment_error', 'current_price', 'current_price_date',
  ],
  fundamentals_eod: [
    'ticker', 'date', 'pe_ratio', 'eps', 'beta', 'dividend_yield', 'week52_high',
    'week52_low', 'fcf_yield', 'debt_to_equity', 'eps_growth', 'source', 'updated_at',
  ],
  analyst_consensus: [
    'ticker', 'date', 'rating', 'target_mean', 'target_high', 'target_low', 'target_median',
    'analyst_count', 'strong_buy', 'buy', 'hold', 'sell', 'strong_sell', 'source', 'updated_at',
  ],
};

export interface SnapshotTableInfo {
  objectKey: string;
  rowCount: number;
}

export interface SnapshotManifest {
  generatedAt: string; // ISO timestamp the snapshot finished writing
  snapshotDate: string; // YYYY-MM-DD the snapshot covers
  format: 'ndjson';
  tables: Record<string, SnapshotTableInfo>;
  schema: Record<string, string[]>;
}

const PAGE = 10_000;
// R2 multipart requires every part except the last to be >= 5 MiB. A JS string's
// length (UTF-16 code units) is <= its UTF-8 byte length, so flushing at >= 5 MiB
// of characters guarantees the uploaded part clears the byte minimum.
const PART_THRESHOLD = 5 * 1024 * 1024;

/** R2 object key for one table's NDJSON dump on a given date. */
export function snapshotObjectKey(date: string, table: string): string {
  return `bulk/${date}/${table}.ndjson`;
}

/** R2 object key for the snapshot manifest on a given date. */
export function manifestObjectKey(date: string): string {
  return `bulk/${date}/manifest.json`;
}

/**
 * Page one table out of D1 and stream it to R2 as NDJSON. Uses multipart upload
 * once the buffer crosses the 5 MiB part threshold; small tables (and the final
 * remainder) are written in a single PUT. Returns the row count written.
 */
async function writeTableNdjson(env: Env, key: string, table: string, orderBy: string): Promise<number> {
  let offset = 0;
  let rowCount = 0;
  let buffer = '';
  let mpu: R2MultipartUpload | null = null;
  const parts: R2UploadedPart[] = [];

  for (;;) {
    // table + orderBy come from the SNAPSHOT_TABLES closed set, never user input.
    const rows = await all<Record<string, unknown>>(
      env.DB,
      `SELECT * FROM ${table} ORDER BY ${orderBy} LIMIT ${PAGE} OFFSET ${offset}`,
    );
    if (rows.length === 0) break;
    for (const row of rows) buffer += JSON.stringify(row) + '\n';
    rowCount += rows.length;
    offset += rows.length;
    if (buffer.length >= PART_THRESHOLD) {
      // Flush a >= 5 MiB part (R2's minimum for any part but the last).
      mpu ??= await env.RAW_FILES.createMultipartUpload(key);
      parts.push(await mpu.uploadPart(parts.length + 1, buffer));
      buffer = '';
    }
    if (rows.length < PAGE) break;
  }

  if (mpu) {
    if (buffer.length > 0) parts.push(await mpu.uploadPart(parts.length + 1, buffer)); // final part may be < 5 MiB
    await mpu.complete(parts);
  } else {
    // Small (or empty) table — a single PUT, no multipart ceremony.
    await env.RAW_FILES.put(key, buffer);
  }
  return rowCount;
}

/**
 * Write the full daily snapshot (all tables + manifest) to R2 and return the
 * manifest. The manifest is written LAST, so if the run aborts mid-way the
 * manifest is absent and readers see "not available" rather than a partial set.
 * Re-running the same date overwrites the same keys (idempotent).
 */
export async function runBulkSnapshot(env: Env, date: string, now = new Date()): Promise<SnapshotManifest> {
  const tables: Record<string, SnapshotTableInfo> = {};
  for (const spec of SNAPSHOT_TABLES) {
    const key = snapshotObjectKey(date, spec.name);
    const rowCount = await writeTableNdjson(env, key, spec.name, spec.orderBy);
    tables[spec.name] = { objectKey: key, rowCount };
  }
  const manifest: SnapshotManifest = {
    generatedAt: now.toISOString(),
    snapshotDate: date,
    format: 'ndjson',
    tables,
    schema: SNAPSHOT_SCHEMA,
  };
  await env.RAW_FILES.put(manifestObjectKey(date), JSON.stringify(manifest), {
    httpMetadata: { contentType: 'application/json' },
  });
  return manifest;
}

/** Read a previously-written manifest from R2, or null if absent. */
export async function readManifest(env: Env, date: string): Promise<SnapshotManifest | null> {
  const obj = await env.RAW_FILES.get(manifestObjectKey(date));
  if (!obj) return null;
  try {
    return (await obj.json()) as SnapshotManifest;
  } catch {
    return null;
  }
}
