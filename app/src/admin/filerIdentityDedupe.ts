/**
 * src/admin/filerIdentityDedupe.ts
 *
 * One-time / repeatable backfill that merges `filers` rows which forked for
 * the same real member (see shared/filerIdentityMatch.ts for the matching
 * rule this applies: same chamber + state, first+last name equal modulo a
 * middle initial/punctuation/generational suffix). Fixes issue #1452 — the
 * live directory showing "Michael T. McCaul" and "Michael McCaul" as two
 * separate filers with split stats.
 *
 * Reversible-safe: NEVER deletes a filer row. The alias row is tombstoned
 * via `merged_into` (migration 0078) and every alias -> canonical rewrite is
 * recorded in `filer_identity_merges` so the merge is auditable (and, if
 * ever necessary, reversible by hand from that mapping).
 *
 * Idempotent: safe to call repeatedly (POST /api/admin/dedupe-filer-identities,
 * or a cron). Already-tombstoned rows are excluded from re-clustering
 * (`WHERE merged_into IS NULL`), and every previously-recorded alias ->
 * canonical mapping is re-swept on each call so any straggler transactions/
 * filings that land under an old alias id (e.g. a narrow race with
 * ingestion's match-time resolution, ingestion/watcher.ts
 * resolveIngestFilerId) get pulled onto the canonical id too.
 */

import type { Env } from '../shared/types.ts';
import { all, run } from '../shared/db.ts';
import { memberNameMatchKey, sameFilerIdentity } from '../shared/filerIdentityMatch.ts';

interface FilerRow {
  bioguide_id: string;
  full_name: string | null;
  chamber: string | null;
  party: string | null;
  state: string | null;
  district: string | null;
  photo_url: string | null;
  resolved_bioguide_id: string | null;
}

export interface FilerIdentityMergeDetail {
  canonicalId: string;
  canonicalName: string | null;
  aliasIds: string[];
  transactionsMoved: number;
  filingsMoved: number;
}

export interface FilerIdentityDedupeResult {
  clustersFound: number;
  aliasesTombstoned: number;
  transactionsMoved: number;
  filingsMoved: number;
  /** Rows re-pointed by the defensive resweep of already-recorded merges. */
  resweptRows: number;
  details: FilerIdentityMergeDetail[];
}

/**
 * Deterministic canonical pick within a matched cluster:
 *   1. Prefer a row that already carries resolved_bioguide_id — an
 *      authoritative congress-legislators enrichment match.
 *   2. Otherwise prefer the row with the most live (non-deprecated)
 *      transactions — the majority-evidence variant.
 *   3. Tie-break on the lexicographically smallest bioguide_id, so reruns
 *      (and reruns against a snapshot with the same data) always agree.
 */
function pickCanonical(cluster: FilerRow[], txCounts: Map<string, number>): FilerRow {
  const withResolved = cluster.filter((r) => r.resolved_bioguide_id);
  const pool = withResolved.length ? withResolved : cluster;
  return pool.slice().sort((a, b) => {
    const countDiff = (txCounts.get(b.bioguide_id) ?? 0) - (txCounts.get(a.bioguide_id) ?? 0);
    if (countDiff !== 0) return countDiff;
    return a.bioguide_id.localeCompare(b.bioguide_id);
  })[0];
}

async function mergeClusterOnto(
  env: Env,
  canonical: FilerRow,
  aliases: FilerRow[],
  nowIso: string,
): Promise<FilerIdentityMergeDetail> {
  let transactionsMoved = 0;
  let filingsMoved = 0;
  const aliasIds: string[] = [];

  for (const alias of aliases) {
    const txRes = await run(env.DB, 'UPDATE transactions SET filer_id = ? WHERE filer_id = ?', [
      canonical.bioguide_id,
      alias.bioguide_id,
    ]);
    transactionsMoved += txRes.meta?.changes ?? 0;

    const filRes = await run(env.DB, 'UPDATE filings SET filer_id = ? WHERE filer_id = ?', [
      canonical.bioguide_id,
      alias.bioguide_id,
    ]);
    filingsMoved += filRes.meta?.changes ?? 0;

    // Backfill metadata onto the canonical row from the alias without ever
    // overwriting a value canonical already has (COALESCE-preserve — mirrors
    // admin/routes.ts applyMemberFilerMerge's curated-merge pattern).
    await run(
      env.DB,
      `UPDATE filers SET
         party = COALESCE(NULLIF(party, ''), ?),
         state = COALESCE(NULLIF(state, ''), ?),
         district = COALESCE(NULLIF(district, ''), ?),
         photo_url = COALESCE(NULLIF(photo_url, ''), ?),
         resolved_bioguide_id = COALESCE(NULLIF(resolved_bioguide_id, ''), ?)
       WHERE bioguide_id = ?`,
      [alias.party, alias.state, alias.district, alias.photo_url, alias.resolved_bioguide_id, canonical.bioguide_id],
    );

    // Tombstone — never delete. merged_into makes the alias row inert for
    // every future dedupe pass and for any read that filters it out.
    await run(env.DB, 'UPDATE filers SET merged_into = ? WHERE bioguide_id = ?', [
      canonical.bioguide_id,
      alias.bioguide_id,
    ]);

    await run(
      env.DB,
      `INSERT INTO filer_identity_merges (alias_filer_id, canonical_filer_id, chamber, state, reason, merged_at)
       VALUES (?, ?, ?, ?, 'name-normalization', ?)
       ON CONFLICT(alias_filer_id) DO UPDATE SET
         canonical_filer_id = excluded.canonical_filer_id,
         merged_at = excluded.merged_at`,
      [alias.bioguide_id, canonical.bioguide_id, canonical.chamber, canonical.state, nowIso],
    );

    aliasIds.push(alias.bioguide_id);
  }

  return {
    canonicalId: canonical.bioguide_id,
    canonicalName: canonical.full_name,
    aliasIds,
    transactionsMoved,
    filingsMoved,
  };
}

/** Re-apply every already-recorded alias -> canonical rewrite. Cheap
 *  (indexed filer_id lookups, bounded by the number of past merges — not a
 *  table scan) and is what makes the whole routine safe to run on a
 *  schedule, not just once. */
async function resweepRecordedMerges(env: Env): Promise<number> {
  const merges = await all<{ alias_filer_id: string; canonical_filer_id: string }>(
    env.DB,
    'SELECT alias_filer_id, canonical_filer_id FROM filer_identity_merges',
  );
  let rows = 0;
  for (const m of merges) {
    const txRes = await run(env.DB, 'UPDATE transactions SET filer_id = ? WHERE filer_id = ?', [
      m.canonical_filer_id,
      m.alias_filer_id,
    ]);
    const filRes = await run(env.DB, 'UPDATE filings SET filer_id = ? WHERE filer_id = ?', [
      m.canonical_filer_id,
      m.alias_filer_id,
    ]);
    rows += (txRes.meta?.changes ?? 0) + (filRes.meta?.changes ?? 0);
  }
  return rows;
}

export async function dedupeSplitFilerIdentities(env: Env): Promise<FilerIdentityDedupeResult> {
  const filers = await all<FilerRow>(
    env.DB,
    `SELECT bioguide_id, full_name, chamber, party, state, district, photo_url, resolved_bioguide_id
       FROM filers
      WHERE merged_into IS NULL`,
  );
  const txCountRows = await all<{ filer_id: string; tx_count: number }>(
    env.DB,
    `SELECT filer_id, COUNT(*) AS tx_count
       FROM transactions
      WHERE filer_id IS NOT NULL AND deprecated_at IS NULL
      GROUP BY filer_id`,
  );
  const txCounts = new Map(txCountRows.map((r) => [r.filer_id, r.tx_count]));

  // Group by chamber + state + name-key. Only groups with more than one row
  // are candidate forks; a group of one is an ordinary, unambiguous filer.
  const groups = new Map<string, FilerRow[]>();
  for (const f of filers) {
    const chamber = String(f.chamber ?? '').trim().toLowerCase();
    const state = String(f.state ?? '').trim().toUpperCase();
    const key = memberNameMatchKey(f.full_name);
    if (!chamber || !state || !key) continue;
    const groupKey = `${chamber}|${state}|${key}`;
    const list = groups.get(groupKey);
    if (list) list.push(f);
    else groups.set(groupKey, [f]);
  }

  const details: FilerIdentityMergeDetail[] = [];
  let aliasesTombstoned = 0;
  let transactionsMoved = 0;
  let filingsMoved = 0;
  const nowIso = new Date().toISOString();

  for (const cluster of groups.values()) {
    if (cluster.length < 2) continue;
    const canonical = pickCanonical(cluster, txCounts);
    // Belt-and-suspenders: re-verify every alias against sameFilerIdentity
    // (the group key already encodes the same chamber+state+name-key
    // equality, so this should never filter anything out — it's a guard
    // against the grouping logic ever drifting from the matching rule).
    const aliases = cluster
      .filter((f) => f.bioguide_id !== canonical.bioguide_id)
      .filter((f) => sameFilerIdentity(
        { fullName: canonical.full_name, chamber: canonical.chamber, state: canonical.state },
        { fullName: f.full_name, chamber: f.chamber, state: f.state },
      ));
    if (!aliases.length) continue;

    const merged = await mergeClusterOnto(env, canonical, aliases, nowIso);
    transactionsMoved += merged.transactionsMoved;
    filingsMoved += merged.filingsMoved;
    aliasesTombstoned += merged.aliasIds.length;
    details.push(merged);
  }

  const resweptRows = await resweepRecordedMerges(env);

  return {
    clustersFound: details.length,
    aliasesTombstoned,
    transactionsMoved,
    filingsMoved,
    resweptRows,
    details,
  };
}
