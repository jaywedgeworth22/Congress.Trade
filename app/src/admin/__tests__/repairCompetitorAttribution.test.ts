/**
 * src/admin/__tests__/repairCompetitorAttribution.test.ts
 *
 * Runs repairCompetitorAttribution against a real, fully-migrated in-memory
 * SQLite DB (see prices/__tests__/sqliteD1.ts), same harness as
 * filerIdentityDedupe.test.ts — the repair SQL's correctness (which rows
 * move, which stay put, what gets created) is exactly what's under test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMigratedD1, type D1Database, type SqliteDatabase } from '../../prices/__tests__/sqliteD1.ts';
import { repairCompetitorAttribution } from '../competitorAttributionRepair.ts';
import { competitorHouseFilerId } from '../../shared/competitorAttribution.ts';
import type { Env } from '../../shared/types.ts';

let db: SqliteDatabase;
let d1: D1Database;
let env: Env;

beforeEach(async () => {
  ({ db, d1 } = await openMigratedD1());
  env = { DB: d1 } as unknown as Env;
});

afterEach(() => {
  db.close();
});

function insertFiler(row: {
  id: string;
  fullName: string;
  chamber: string;
  state: string;
  district?: string | null;
  resolvedBioguideId?: string | null;
}) {
  db.prepare(
    `INSERT INTO filers (bioguide_id, chamber, full_name, state, district, resolved_bioguide_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.chamber, row.fullName, row.state, row.district ?? null, row.resolvedBioguideId ?? null);
}

let txSeq = 0;
function insertCompetitorTx(row: {
  filerId: string | null;
  rawText: string;
  assetName?: string | null;
  ticker?: string | null;
  assetType?: string | null;
}) {
  txSeq += 1;
  const id = `tx-${txSeq}`;
  db.prepare(
    `INSERT INTO transactions
       (id, doc_id, filer_id, tx_date, asset_name, ticker, asset_type, tx_type,
        raw_text, source, created_at)
     VALUES (?, ?, ?, '2026-01-15', ?, ?, ?, 'P', ?, 'competitor_backfill', '2026-01-15T00:00:00.000Z')`,
  ).run(
    id,
    `COMPETITOR-${id}`,
    row.filerId,
    row.assetName ?? 'Some Asset',
    row.ticker ?? 'TICK',
    row.assetType ?? 'stock',
    row.rawText,
  );
  return id;
}

function getTx(id: string) {
  return db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as Record<string, unknown>;
}

describe('repairCompetitorAttribution', () => {
  it('reassigns a chamber+state mismatch (Rep. Mike Collins GA-10 stuck on Sen. Susan Collins ME)', async () => {
    insertFiler({ id: 'senate-susan-collins', fullName: 'Susan M. Collins', chamber: 'senate', state: 'ME' });
    const rawText = JSON.stringify({
      Representative: 'Hon. Michael A. Collins Jr',
      District: 'GA10',
      Ticker: 'ACME',
      Transaction: 'Purchase',
    });
    const txId = insertCompetitorTx({ filerId: 'senate-susan-collins', rawText, assetName: 'Acme Corp', ticker: 'ACME' });

    const result = await repairCompetitorAttribution(env, { dryRun: false });

    expect(result.scanned).toBe(1);
    expect(result.mismatched).toBe(1);
    expect(result.reassigned).toBe(1);
    expect(result.created).toBe(1);
    expect(result.unparseable).toBe(0);
    expect(result.dryRun).toBe(false);

    const expectedFilerId = competitorHouseFilerId('Hon. Michael A. Collins Jr', 'GA', '10');
    expect(expectedFilerId).toBeTruthy();

    const tx = getTx(txId);
    expect(tx.filer_id).toBe(expectedFilerId);

    const newFiler = db.prepare('SELECT * FROM filers WHERE bioguide_id = ?').get(expectedFilerId) as
      | Record<string, unknown>
      | undefined;
    expect(newFiler).toBeTruthy();
    expect(newFiler?.chamber).toBe('house');
    expect(newFiler?.state).toBe('GA');
    expect(newFiler?.district).toBe('10');

    expect(result.details).toHaveLength(1);
    expect(result.details[0]).toMatchObject({
      fromFilerId: 'senate-susan-collins',
      toFilerId: expectedFilerId,
      count: 1,
    });

    // The mis-attributed Senate filer never sees this transaction again.
    const staleCount = db
      .prepare("SELECT COUNT(*) AS n FROM transactions WHERE filer_id = 'senate-susan-collins'")
      .get() as { n: number };
    expect(staleCount.n).toBe(0);
  });

  it('is a no-op when the raw reporter matches the assigned filer (same chamber + state)', async () => {
    insertFiler({ id: 'house-ga10-michael-collins', fullName: 'Michael Collins', chamber: 'house', state: 'GA', district: '10' });
    const rawText = JSON.stringify({ Representative: 'Michael Collins', District: 'GA10', Ticker: 'ACME' });
    const txId = insertCompetitorTx({ filerId: 'house-ga10-michael-collins', rawText });

    const result = await repairCompetitorAttribution(env, { dryRun: false });

    expect(result.scanned).toBe(1);
    expect(result.mismatched).toBe(0);
    expect(result.reassigned).toBe(0);
    expect(result.created).toBe(0);
    expect(result.details).toHaveLength(0);

    const tx = getTx(txId);
    expect(tx.filer_id).toBe('house-ga10-michael-collins');

    const filerCount = db.prepare('SELECT COUNT(*) AS n FROM filers').get() as { n: number };
    expect(filerCount.n).toBe(1);
  });

  it('reclassifies a crypto disclosure mis-stored as asset_type=stock', async () => {
    insertFiler({ id: 'house-ga10-michael-collins', fullName: 'Michael Collins', chamber: 'house', state: 'GA', district: '10' });
    const rawText = JSON.stringify({
      Representative: 'Michael Collins',
      District: 'GA10',
      Ticker: 'SUI',
      notes: 'Sui Network purchase [CT]',
    });
    const txId = insertCompetitorTx({
      filerId: 'house-ga10-michael-collins',
      rawText,
      assetName: 'Sun Communities',
      ticker: 'SUI',
      assetType: 'stock',
    });

    const result = await repairCompetitorAttribution(env, { dryRun: false });

    expect(result.cryptoReclassified).toBe(1);
    // Same-chamber/state reporter — no attribution mismatch alongside the crypto fix.
    expect(result.mismatched).toBe(0);

    const tx = getTx(txId);
    expect(tx.asset_type).toBe('CT');
    expect(tx.asset_type_name).toBe('Cryptocurrency');
  });

  it('does not reclassify a row that already carries no crypto marker', async () => {
    insertFiler({ id: 'house-ga10-michael-collins', fullName: 'Michael Collins', chamber: 'house', state: 'GA', district: '10' });
    const rawText = JSON.stringify({ Representative: 'Michael Collins', District: 'GA10', notes: 'Ordinary equity buy' });
    const txId = insertCompetitorTx({ filerId: 'house-ga10-michael-collins', rawText, assetName: 'Acme Corp', ticker: 'ACME' });

    const result = await repairCompetitorAttribution(env, { dryRun: false });

    expect(result.cryptoReclassified).toBe(0);
    const tx = getTx(txId);
    expect(tx.asset_type).toBe('stock');
  });

  it('counts unparseable rows (raw_text with no derivable reporter name)', async () => {
    insertFiler({ id: 'senate-susan-collins', fullName: 'Susan M. Collins', chamber: 'senate', state: 'ME' });
    insertCompetitorTx({ filerId: 'senate-susan-collins', rawText: JSON.stringify({ Ticker: 'ACME', Transaction: 'Purchase' }) });

    const result = await repairCompetitorAttribution(env, { dryRun: false });

    expect(result.unparseable).toBe(1);
    expect(result.mismatched).toBe(0);
    expect(result.reassigned).toBe(0);
  });

  it('dryRun reports the same counts but writes nothing', async () => {
    insertFiler({ id: 'senate-susan-collins', fullName: 'Susan M. Collins', chamber: 'senate', state: 'ME' });
    const rawText = JSON.stringify({
      Representative: 'Hon. Michael A. Collins Jr',
      District: 'GA10',
      Ticker: 'SUI',
      notes: 'Sui purchase [CT]',
    });
    const txId = insertCompetitorTx({
      filerId: 'senate-susan-collins',
      rawText,
      assetName: 'Sun Communities',
      ticker: 'SUI',
      assetType: 'stock',
    });

    const result = await repairCompetitorAttribution(env, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.mismatched).toBe(1);
    expect(result.reassigned).toBe(1);
    expect(result.created).toBe(1);
    expect(result.cryptoReclassified).toBe(1);

    // Nothing actually written: transaction untouched, no new filer row.
    const tx = getTx(txId);
    expect(tx.filer_id).toBe('senate-susan-collins');
    expect(tx.asset_type).toBe('stock');

    const filerCount = db.prepare('SELECT COUNT(*) AS n FROM filers').get() as { n: number };
    expect(filerCount.n).toBe(1);

    // Re-running for real still finds (and fixes) the same row — dryRun never
    // consumed the fix.
    const second = await repairCompetitorAttribution(env, { dryRun: false });
    expect(second.reassigned).toBe(1);
    expect(second.cryptoReclassified).toBe(1);
  });

  it('is idempotent — a second run finds nothing left to fix', async () => {
    insertFiler({ id: 'senate-susan-collins', fullName: 'Susan M. Collins', chamber: 'senate', state: 'ME' });
    const rawText = JSON.stringify({
      Representative: 'Hon. Michael A. Collins Jr',
      District: 'GA10',
      Ticker: 'SUI',
      notes: 'Sui purchase [CT]',
    });
    insertCompetitorTx({
      filerId: 'senate-susan-collins',
      rawText,
      assetName: 'Sun Communities',
      ticker: 'SUI',
      assetType: 'stock',
    });

    await repairCompetitorAttribution(env, { dryRun: false });
    const second = await repairCompetitorAttribution(env, { dryRun: false });

    expect(second.mismatched).toBe(0);
    expect(second.reassigned).toBe(0);
    expect(second.created).toBe(0);
    expect(second.cryptoReclassified).toBe(0);
  });
});
