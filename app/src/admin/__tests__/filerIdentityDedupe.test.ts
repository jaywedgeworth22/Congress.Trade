/**
 * src/admin/__tests__/filerIdentityDedupe.test.ts
 *
 * Runs dedupeSplitFilerIdentities against a real, fully-migrated in-memory
 * SQLite DB (see prices/__tests__/sqliteD1.ts) rather than a hand-rolled
 * mock — the merge SQL's correctness (which rows move, which stay put, the
 * COALESCE-preserve metadata backfill) is exactly what's under test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMigratedD1, type D1Database, type SqliteDatabase } from '../../prices/__tests__/sqliteD1.ts';
import { dedupeSplitFilerIdentities } from '../filerIdentityDedupe.ts';
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
  party?: string | null;
  district?: string | null;
  photoUrl?: string | null;
  resolvedBioguideId?: string | null;
}) {
  db.prepare(
    `INSERT INTO filers (bioguide_id, chamber, full_name, party, state, district, photo_url, resolved_bioguide_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.chamber,
    row.fullName,
    row.party ?? null,
    row.state,
    row.district ?? null,
    row.photoUrl ?? null,
    row.resolvedBioguideId ?? null,
  );
}

let txSeq = 0;
function insertTx(filerId: string, opts: { deprecated?: boolean } = {}) {
  txSeq += 1;
  db.prepare(
    `INSERT INTO transactions (id, doc_id, filer_id, tx_date, deprecated_at)
     VALUES (?, ?, ?, '2026-01-01', ?)`,
  ).run(`tx-${txSeq}`, `doc-${txSeq}`, filerId, opts.deprecated ? '2026-02-01T00:00:00.000Z' : null);
}

function insertFiling(docId: string, filerId: string) {
  db.prepare(`INSERT INTO filings (doc_id, chamber, filer_id, filing_type, ingest_status) VALUES (?, 'house', ?, 'P', 'persisted')`).run(
    docId,
    filerId,
  );
}

describe('dedupeSplitFilerIdentities', () => {
  it('merges a middle-initial fork (issue #1452, the McCaul pair) onto the higher-tx_count row', async () => {
    insertFiler({ id: 'house-tx10-michael-t-mccaul', fullName: 'Michael T. McCaul', chamber: 'house', state: 'TX' });
    insertFiler({ id: 'house-tx10-michael-mccaul', fullName: 'Michael McCaul', chamber: 'house', state: 'TX' });
    for (let i = 0; i < 5; i++) insertTx('house-tx10-michael-t-mccaul');
    for (let i = 0; i < 3; i++) insertTx('house-tx10-michael-mccaul');
    insertFiling('doc-a', 'house-tx10-michael-t-mccaul');
    insertFiling('doc-b', 'house-tx10-michael-mccaul');

    const result = await dedupeSplitFilerIdentities(env);

    expect(result.clustersFound).toBe(1);
    expect(result.aliasesTombstoned).toBe(1);
    expect(result.transactionsMoved).toBe(3);
    expect(result.filingsMoved).toBe(1);
    expect(result.details[0].canonicalId).toBe('house-tx10-michael-t-mccaul');
    expect(result.details[0].aliasIds).toEqual(['house-tx10-michael-mccaul']);

    // The alias row is tombstoned, never deleted.
    const alias = db.prepare('SELECT bioguide_id, merged_into FROM filers WHERE bioguide_id = ?').get(
      'house-tx10-michael-mccaul',
    ) as { bioguide_id: string; merged_into: string | null };
    expect(alias).toBeTruthy();
    expect(alias.merged_into).toBe('house-tx10-michael-t-mccaul');

    // Every transaction now attributes to the canonical id — one distinct
    // filer instead of two split stat lines.
    const distinctFilers = db
      .prepare('SELECT DISTINCT filer_id FROM transactions')
      .all() as Array<{ filer_id: string }>;
    expect(distinctFilers).toEqual([{ filer_id: 'house-tx10-michael-t-mccaul' }]);

    // Durable, auditable mapping — never silently lost.
    const mapping = db
      .prepare('SELECT alias_filer_id, canonical_filer_id FROM filer_identity_merges WHERE alias_filer_id = ?')
      .get('house-tx10-michael-mccaul') as { alias_filer_id: string; canonical_filer_id: string };
    expect(mapping.canonical_filer_id).toBe('house-tx10-michael-t-mccaul');
  });

  it('is idempotent — a second run finds nothing left to merge', async () => {
    insertFiler({ id: 'house-tx10-michael-t-mccaul', fullName: 'Michael T. McCaul', chamber: 'house', state: 'TX' });
    insertFiler({ id: 'house-tx10-michael-mccaul', fullName: 'Michael McCaul', chamber: 'house', state: 'TX' });
    insertTx('house-tx10-michael-t-mccaul');
    insertTx('house-tx10-michael-mccaul');

    await dedupeSplitFilerIdentities(env);
    const second = await dedupeSplitFilerIdentities(env);

    expect(second.clustersFound).toBe(0);
    expect(second.aliasesTombstoned).toBe(0);
    expect(second.transactionsMoved).toBe(0);
    expect(second.filingsMoved).toBe(0);
  });

  it('self-heals a straggler transaction that lands under an already-merged alias id', async () => {
    insertFiler({ id: 'house-tx10-michael-t-mccaul', fullName: 'Michael T. McCaul', chamber: 'house', state: 'TX' });
    insertFiler({ id: 'house-tx10-michael-mccaul', fullName: 'Michael McCaul', chamber: 'house', state: 'TX' });
    // Give the "-t-" row more transactions so it deterministically wins
    // canonical (tx_count tie-break), matching the first test above.
    for (let i = 0; i < 3; i++) insertTx('house-tx10-michael-t-mccaul');
    insertTx('house-tx10-michael-mccaul');
    const first = await dedupeSplitFilerIdentities(env);
    expect(first.details[0].canonicalId).toBe('house-tx10-michael-t-mccaul');

    // Simulate a race: something inserts one more row under the now-tombstoned
    // alias id after the first merge pass.
    insertTx('house-tx10-michael-mccaul');

    const second = await dedupeSplitFilerIdentities(env);
    expect(second.resweptRows).toBeGreaterThanOrEqual(1);

    const stragglers = db
      .prepare("SELECT COUNT(*) AS n FROM transactions WHERE filer_id = 'house-tx10-michael-mccaul'")
      .get() as { n: number };
    expect(stragglers.n).toBe(0);
  });

  it('does not merge across state', async () => {
    insertFiler({ id: 'a', fullName: 'Michael T. McCaul', chamber: 'house', state: 'TX' });
    insertFiler({ id: 'b', fullName: 'Michael McCaul', chamber: 'house', state: 'CA' });
    insertTx('a');
    insertTx('b');

    const result = await dedupeSplitFilerIdentities(env);
    expect(result.clustersFound).toBe(0);
  });

  it('does not merge across chamber', async () => {
    insertFiler({ id: 'a', fullName: 'Michael T. McCaul', chamber: 'house', state: 'TX' });
    insertFiler({ id: 'b', fullName: 'Michael McCaul', chamber: 'senate', state: 'TX' });
    insertTx('a');
    insertTx('b');

    const result = await dedupeSplitFilerIdentities(env);
    expect(result.clustersFound).toBe(0);
  });

  it('does not merge two different people who share a last name', async () => {
    insertFiler({ id: 'a', fullName: 'John Smith', chamber: 'house', state: 'CA' });
    insertFiler({ id: 'b', fullName: 'Jane Smith', chamber: 'house', state: 'CA' });
    insertTx('a');
    insertTx('b');

    const result = await dedupeSplitFilerIdentities(env);
    expect(result.clustersFound).toBe(0);
    const rows = db.prepare('SELECT bioguide_id, merged_into FROM filers ORDER BY bioguide_id').all() as Array<{
      bioguide_id: string;
      merged_into: string | null;
    }>;
    expect(rows.every((r) => r.merged_into === null)).toBe(true);
  });

  it('prefers a resolved_bioguide_id match as canonical even against a higher tx_count, and backfills metadata onto it without overwriting what it already has', async () => {
    insertFiler({
      id: 'house-tx10-michael-t-mccaul',
      fullName: 'Michael T. McCaul',
      chamber: 'house',
      state: 'TX',
      party: 'Republican',
      // No resolved_bioguide_id — but wins on raw tx_count alone.
    });
    insertFiler({
      id: 'house-tx10-michael-mccaul',
      fullName: 'Michael McCaul',
      chamber: 'house',
      state: 'TX',
      district: '10',
      photoUrl: 'https://example.test/mccaul.jpg',
      resolvedBioguideId: 'M001157',
    });
    // The non-resolved row has far more transactions, but resolved_bioguide_id
    // (an authoritative congress-legislators match) outranks tx_count.
    for (let i = 0; i < 10; i++) insertTx('house-tx10-michael-t-mccaul');
    insertTx('house-tx10-michael-mccaul');

    const result = await dedupeSplitFilerIdentities(env);
    expect(result.details[0].canonicalId).toBe('house-tx10-michael-mccaul');

    const canonical = db
      .prepare('SELECT party, district, photo_url, resolved_bioguide_id FROM filers WHERE bioguide_id = ?')
      .get('house-tx10-michael-mccaul') as {
      party: string | null;
      district: string | null;
      photo_url: string | null;
      resolved_bioguide_id: string | null;
    };
    expect(canonical.party).toBe('Republican'); // filled from the alias
    expect(canonical.district).toBe('10'); // preserved, not overwritten
    expect(canonical.photo_url).toBe('https://example.test/mccaul.jpg');
    expect(canonical.resolved_bioguide_id).toBe('M001157');
  });

  it('ignores rows already tombstoned by an earlier merge (never re-clusters them)', async () => {
    insertFiler({ id: 'a', fullName: 'Michael T. McCaul', chamber: 'house', state: 'TX' });
    insertFiler({ id: 'b', fullName: 'Michael McCaul', chamber: 'house', state: 'TX' });
    insertTx('a');
    insertTx('b');
    await dedupeSplitFilerIdentities(env);

    // A brand-new third fork of the same person shows up later.
    insertFiler({ id: 'c', fullName: 'Mike McCaul', chamber: 'house', state: 'TX' });
    insertTx('c');
    const second = await dedupeSplitFilerIdentities(env);

    // "Mike" != "Michael" under memberNameMatchKey (not a middle-initial
    // variance), so it forms its own singleton — not merged, and the
    // already-tombstoned 'b' is not reconsidered.
    expect(second.clustersFound).toBe(0);
    const bRow = db.prepare('SELECT merged_into FROM filers WHERE bioguide_id = ?').get('b') as {
      merged_into: string | null;
    };
    expect(bRow.merged_into).toBe('a');
  });
});
