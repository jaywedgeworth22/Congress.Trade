/**
 * src/enrichment/committeeSync.ts
 *
 * Committee membership sync: fills filers.committees, a free-text JSON
 * string-array column (see src/analytics/conflicts.ts for why there's no
 * controlled vocabulary) that today is never populated by any ingestion or
 * backfill path — every INSERT hardcodes NULL/'[]' (watcher.ts, seed.ts,
 * fmpSenateRecovery.ts, applyMemberFilerMerge in admin/routes.ts).
 *
 * Source: the unitedstates/congress-legislators project's hosted JSON —
 * the same family already used for photo/party/bioguide enrichment
 * (see LEGISLATOR_SOURCES in admin/routes.ts):
 *   - committees-current.json      — top-level House/Senate/Joint committees
 *                                    + their subcommittees, keyed by thomas_id.
 *   - committee-membership-current.json — thomas_id (or thomas_id + subcommittee
 *                                    thomas_id, e.g. "SSAF13") -> member list,
 *                                    each member carrying a bioguide id.
 *
 * Subcommittee memberships roll up to their parent committee's *official*
 * display name (e.g. "House Committee on Financial Services"), deduped, and
 * that's what gets written to filers.committees. Official names already
 * contain the exact lowercase tokens conflicts.ts's COMMITTEE_SECTOR_RULES
 * matches against ("financial services", "armed services", "ways and means",
 * "finance" for Senate Finance without also hitting "financial", ...) — see
 * the matching test in __tests__/committeeSync.test.ts — so no separate
 * name-rewriting step is needed here.
 *
 * This module only *joins* on filers.resolved_bioguide_id, which the photo
 * enrichment / member-identity-merge paths already populate — it does not do
 * its own name -> bioguide matching.
 */

import type { Env } from '../shared/types.ts';
import { all, batchPrepared } from '../shared/db.ts';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';

export const COMMITTEES_CURRENT_URL =
  'https://unitedstates.github.io/congress-legislators/committees-current.json';
export const COMMITTEE_MEMBERSHIP_URL =
  'https://unitedstates.github.io/congress-legislators/committee-membership-current.json';

export interface CommitteeSubcommittee {
  thomas_id?: string;
  name?: string;
}

export interface CommitteeRecord {
  type?: string; // "house" | "senate" | "joint"
  name?: string;
  thomas_id?: string;
  subcommittees?: CommitteeSubcommittee[];
}

export interface CommitteeMembershipEntry {
  name?: string;
  party?: string;
  rank?: number;
  title?: string;
  bioguide?: string;
}

/** thomas_id (top-level) or thomas_id+subcommittee-thomas_id -> member list. */
export type CommitteeMembershipMap = Record<string, CommitteeMembershipEntry[]>;

export interface CommitteeIndex {
  /** Top-level committee thomas_id -> official display name. */
  nameByThomasId: Map<string, string>;
  /** Any membership-file key (top-level OR subcommittee) -> owning top-level thomas_id. */
  parentThomasIdByKey: Map<string, string>;
}

/**
 * Index committees-current.json: top-level thomas_id -> display name, and a
 * lookup from every membership-file key (top-level id, or top-level id +
 * subcommittee id concatenated, e.g. "HSAG" + "15" -> "HSAG15") back to its
 * owning top-level committee. Unknown/malformed entries are skipped.
 */
export function buildCommitteeIndex(committees: CommitteeRecord[]): CommitteeIndex {
  const nameByThomasId = new Map<string, string>();
  const parentThomasIdByKey = new Map<string, string>();
  for (const c of committees ?? []) {
    if (!c || typeof c.thomas_id !== 'string' || !c.thomas_id || typeof c.name !== 'string' || !c.name) continue;
    nameByThomasId.set(c.thomas_id, c.name);
    parentThomasIdByKey.set(c.thomas_id, c.thomas_id);
    for (const sub of c.subcommittees ?? []) {
      if (!sub || typeof sub.thomas_id !== 'string' || !sub.thomas_id) continue;
      parentThomasIdByKey.set(c.thomas_id + sub.thomas_id, c.thomas_id);
    }
  }
  return { nameByThomasId, parentThomasIdByKey };
}

/**
 * Roll committee-membership-current.json up to bioguide_id -> sorted, deduped
 * top-level committee display names. Subcommittee-only memberships collapse
 * onto their parent; membership keys with no match in the committee index
 * (e.g. a stale/removed committee) are skipped rather than guessed at.
 */
export function buildBioguideCommitteeMap(
  membership: CommitteeMembershipMap,
  index: CommitteeIndex,
): Map<string, string[]> {
  const byBioguide = new Map<string, Set<string>>();
  for (const [key, members] of Object.entries(membership ?? {})) {
    const parentId = index.parentThomasIdByKey.get(key);
    if (!parentId) continue;
    const name = index.nameByThomasId.get(parentId);
    if (!name) continue;
    for (const m of members ?? []) {
      const bioguide = m?.bioguide;
      if (!bioguide) continue;
      if (!byBioguide.has(bioguide)) byBioguide.set(bioguide, new Set());
      byBioguide.get(bioguide)!.add(name);
    }
  }
  const result = new Map<string, string[]>();
  for (const [bioguide, names] of byBioguide) {
    result.set(bioguide, [...names].sort());
  }
  return result;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await trackedFetch(
    url,
    {
      headers: {
        'user-agent': 'congress-feed/0.1 (+https://congress.trade)',
        accept: 'application/json',
      },
    },
    { service: 'committee-sync', operation: 'fetch-committee-data' },
  );
  if (!res.ok) {
    throw new Error(`committeeSync: fetch failed (${res.status}) for ${url}`);
  }
  return (await res.json()) as T;
}

/** Fetch + build the bioguide_id -> committee display names map from the live hosted JSON. */
export async function fetchBioguideCommitteeMap(): Promise<Map<string, string[]>> {
  const [committees, membership] = await Promise.all([
    fetchJson<CommitteeRecord[]>(COMMITTEES_CURRENT_URL),
    fetchJson<CommitteeMembershipMap>(COMMITTEE_MEMBERSHIP_URL),
  ]);
  const index = buildCommitteeIndex(committees);
  return buildBioguideCommitteeMap(membership, index);
}

export interface FilerCommitteeRow {
  bioguide_id: string;
  resolved_bioguide_id: string | null;
  committees: string | null;
}

export interface CommitteeUpdatePlanEntry {
  filerId: string;
  committees: string[];
}

export interface CommitteeUpdatePlan {
  updates: CommitteeUpdatePlanEntry[];
  /** resolved_bioguide_id present, memberships found, but already matches stored committees. */
  skipped: number;
  /** resolved_bioguide_id present but no committee memberships found for that bioguide. */
  unmatched: number;
}

/**
 * Pure planning step (no DB/network): decide which filers.committees rows
 * actually need writing. Only considers filers that already carry
 * resolved_bioguide_id (per task scope — this module does not itself resolve
 * names to bioguide ids). Skips rows whose stored JSON already matches the
 * (sorted, deduped) computed list, so re-runs are cheap no-ops.
 */
export function planCommitteeUpdates(
  filers: readonly FilerCommitteeRow[],
  bioguideMap: ReadonlyMap<string, string[]>,
): CommitteeUpdatePlan {
  const updates: CommitteeUpdatePlanEntry[] = [];
  let skipped = 0;
  let unmatched = 0;
  for (const f of filers) {
    const bioguide = f.resolved_bioguide_id;
    if (!bioguide) continue;
    const names = bioguideMap.get(bioguide);
    if (!names || names.length === 0) {
      unmatched++;
      continue;
    }
    const nextJson = JSON.stringify(names);
    const current = (f.committees ?? '').trim();
    if (current === nextJson) {
      skipped++;
      continue;
    }
    updates.push({ filerId: f.bioguide_id, committees: names });
  }
  return { updates, skipped, unmatched };
}

export interface CommitteeSyncResult {
  /** Filers considered (resolved_bioguide_id IS NOT NULL AND <> ''). */
  filersScanned: number;
  updated: number;
  skipped: number;
  unmatched: number;
}

/**
 * Fetch the current committee roster from congress-legislators and write
 * filers.committees for every filer with a resolved_bioguide_id, batching
 * writes the way other backfill code in app/src does (50 statements per
 * D1 batch). Safe to re-run — only rows whose computed value differs from
 * what's stored are updated. Does not touch filers lacking a
 * resolved_bioguide_id; that resolution happens elsewhere (runPhotoEnrichment /
 * repairMemberIdentityMerges).
 */
export async function runCommitteeSync(env: Env): Promise<CommitteeSyncResult> {
  const bioguideMap = await fetchBioguideCommitteeMap();
  const filers = await all<FilerCommitteeRow>(
    env.DB,
    "SELECT bioguide_id, resolved_bioguide_id, committees FROM filers " +
      "WHERE resolved_bioguide_id IS NOT NULL AND resolved_bioguide_id <> ''",
  );
  const { updates, skipped, unmatched } = planCommitteeUpdates(filers, bioguideMap);

  const statements = updates.map((u) =>
    env.DB.prepare('UPDATE filers SET committees = ? WHERE bioguide_id = ?').bind(
      JSON.stringify(u.committees),
      u.filerId,
    ),
  );
  for (let i = 0; i < statements.length; i += 50) {
    await batchPrepared(env.DB, statements.slice(i, i + 50));
  }

  return {
    filersScanned: filers.length,
    updated: updates.length,
    skipped,
    unmatched,
  };
}
