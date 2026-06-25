/**
 * src/export/snapshot.ts
 * OWNER: export
 *
 * Daily bulk snapshot writer: dumps the market-data tables App B bootstraps from
 * (prices, S&P, securities reference, fundamentals, analyst consensus) to R2 as
 * NDJSON — one JSON object per line — under a date- AND run-partitioned key
 * prefix, plus a manifest written LAST so a partially-written run is invisible to
 * readers.
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
 * Why run-scoped keys: each run writes its table files under a unique
 * `bulk/{date}/runs/{runId}/` prefix and only then publishes the manifest at the
 * stable `bulk/{date}/manifest.json`. The manifest's `objectKey`s point at that
 * run's files, and downloads resolve through the manifest — so a same-day rerun
 * (e.g. an inline back-fill racing the cron) can never leave the published
 * manifest pointing at a half-rewritten file. Old run prefixes are orphaned
 * (negligible R2 cost) but the manifest is always internally consistent.
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
    'market_cap', 'market_cap_bucket', 'shares_outstanding', 'ipo_date', 'cik', 'sic_code',
    'sic_description', 'source', 'enriched_at', 'enrichment_error', 'current_price',
    'current_price_date',
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
  runId: string; // unique id of the run that produced these files
  format: 'ndjson';
  tables: Record<string, SnapshotTableInfo>;
  schema: Record<string, string[]>;
}

const PAGE = 10_000;
// Fixed multipart part size. R2 requires EVERY part except the last to be the
// same size, so we cut the byte stream into exact PART_SIZE chunks rather than
// flushing whatever a page happened to accumulate. 8 MiB clears R2's 5 MiB
// minimum with headroom and keeps the part count low for big tables.
const PART_SIZE = 8 * 1024 * 1024;

const encoder = new TextEncoder();

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Copy bytes into a fresh ArrayBuffer — R2's binding body type wants ArrayBuffer
 *  (not a view over a possibly-Shared buffer), and this also pins exact length. */
function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u.byteLength);
  new Uint8Array(out).set(u);
  return out;
}

/** R2 object key for one table's NDJSON dump within a run. */
export function snapshotObjectKey(date: string, runId: string, table: string): string {
  return `bulk/${date}/runs/${runId}/${table}.ndjson`;
}

/** R2 object key for the (stable, run-independent) snapshot manifest on a date. */
export function manifestObjectKey(date: string): string {
  return `bulk/${date}/manifest.json`;
}

/**
 * Page one table out of D1 and stream it to R2 as NDJSON. Cuts the UTF-8 byte
 * stream into fixed PART_SIZE multipart parts (R2 requires equal-sized non-final
 * parts); the trailing remainder is the final part. Tables smaller than one part
 * are written in a single PUT. Returns the row count written.
 */
async function writeTableNdjson(env: Env, key: string, table: string, orderBy: string): Promise<number> {
  let offset = 0;
  let rowCount = 0;
  let carry: Uint8Array = new Uint8Array(0); // bytes not yet flushed as a part
  let mpu: R2MultipartUpload | null = null;
  const parts: R2UploadedPart[] = [];

  for (;;) {
    // table + orderBy come from the SNAPSHOT_TABLES closed set, never user input.
    const rows = await all<Record<string, unknown>>(
      env.DB,
      `SELECT * FROM ${table} ORDER BY ${orderBy} LIMIT ${PAGE} OFFSET ${offset}`,
    );
    if (rows.length === 0) break;
    let chunk = '';
    for (const row of rows) chunk += JSON.stringify(row) + '\n';
    rowCount += rows.length;
    offset += rows.length;
    carry = concatBytes(carry, encoder.encode(chunk));
    // Flush as many full, equal-sized parts as the carry now holds.
    while (carry.length >= PART_SIZE) {
      mpu ??= await env.RAW_FILES.createMultipartUpload(key);
      parts.push(await mpu.uploadPart(parts.length + 1, toArrayBuffer(carry.subarray(0, PART_SIZE))));
      carry = carry.slice(PART_SIZE);
    }
    if (rows.length < PAGE) break;
  }

  if (mpu) {
    // Final part carries the remainder (< PART_SIZE; the only part allowed to differ).
    if (carry.length > 0) parts.push(await mpu.uploadPart(parts.length + 1, toArrayBuffer(carry)));
    await mpu.complete(parts);
  } else {
    // Small (or empty) table — a single PUT, no multipart ceremony.
    await env.RAW_FILES.put(key, toArrayBuffer(carry));
  }
  return rowCount;
}

/**
 * Write the full daily snapshot (all tables under a unique run prefix + the
 * stable manifest) to R2 and return the manifest. The manifest is written LAST
 * and points at this run's files, so a partial or racing run never corrupts the
 * published manifest. `runId` is injectable for deterministic tests.
 */
export async function runBulkSnapshot(
  env: Env,
  date: string,
  now = new Date(),
  runId: string = crypto.randomUUID(),
): Promise<SnapshotManifest> {
  const tables: Record<string, SnapshotTableInfo> = {};
  for (const spec of SNAPSHOT_TABLES) {
    const key = snapshotObjectKey(date, runId, spec.name);
    const rowCount = await writeTableNdjson(env, key, spec.name, spec.orderBy);
    tables[spec.name] = { objectKey: key, rowCount };
  }
  const manifest: SnapshotManifest = {
    generatedAt: now.toISOString(),
    snapshotDate: date,
    runId,
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
