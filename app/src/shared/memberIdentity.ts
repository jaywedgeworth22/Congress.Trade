/**
 * Congressional member identity helpers.
 *
 * Some disclosure sources use a member's legal first name while congress-
 * legislators and public surfaces use their preferred / official short name.
 * Without an explicit map, those rows land under separate filer rows and
 * split analytics, photos, and bioguide enrichment.
 *
 * This module is the small, curated allow-list for those renames + the
 * durable filer_id merges that accompany them. Extend carefully — only add
 * pairs that are known to be the same person.
 */

import { normalizePersonName } from './executiveIdentity.ts';

export interface MemberNameAlias {
  /** Official / preferred display name (congress-legislators official_full). */
  canonicalName: string;
  /** Normalized aliases (via normalizePersonName) that map to canonicalName. */
  aliases: readonly string[];
}

/**
 * Preferred public name for known legal-name variants on House/Senate PTRs.
 * Keys are compared after {@link normalizePersonName}.
 */
export const MEMBER_NAME_ALIASES: readonly MemberNameAlias[] = [
  {
    // CA-17 House: legal filings sometimes use "Rohit"; official_full is "Ro Khanna".
    canonicalName: 'Ro Khanna',
    aliases: ['rohit khanna', 'khanna rohit'],
  },
];

/**
 * Durable filer_id merges. First entry is the id we keep; the rest are absorbed.
 * Canonical ids prefer the post-alias house slug (district + preferred name)
 * over MANUAL-* competitor injects and pre-alias legal-name slugs.
 */
export interface MemberFilerMerge {
  /** Filer id that survives. */
  canonicalId: string;
  /** Preferred full_name on the surviving row. */
  canonicalName: string;
  chamber: 'house' | 'senate';
  state?: string | null;
  district?: string | null;
  /** Official Bioguide id when known (stored on filers.resolved_bioguide_id). */
  resolvedBioguideId?: string | null;
  /** Alias filer ids that should be rewritten onto canonicalId. */
  aliasIds: readonly string[];
}

export const MEMBER_FILER_MERGES: readonly MemberFilerMerge[] = [
  {
    canonicalId: 'house-ca17-ro-khanna',
    canonicalName: 'Ro Khanna',
    chamber: 'house',
    state: 'CA',
    district: '17',
    resolvedBioguideId: 'K000389',
    aliasIds: [
      'house-ca17-rohit-khanna',
      'MANUAL-KHANNA',
    ],
  },
];

/**
 * Apply curated legal → preferred name renames. Input should already have
 * honorifics stripped and "Last, First" flipped (cleanFilerName does that
 * first). Returns the preferred display name when an alias matches, else the
 * original string.
 */
export function applyMemberNameAlias(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  const norm = normalizePersonName(trimmed);
  if (!norm) return trimmed;
  for (const entry of MEMBER_NAME_ALIASES) {
    if (normalizePersonName(entry.canonicalName) === norm) {
      return entry.canonicalName;
    }
    if (entry.aliases.some((a) => a === norm)) {
      return entry.canonicalName;
    }
  }
  return trimmed;
}

/** Look up the merge group that owns a given filer id, if any. */
export function memberMergeForFilerId(filerId: string | null | undefined): MemberFilerMerge | null {
  if (!filerId) return null;
  for (const group of MEMBER_FILER_MERGES) {
    if (group.canonicalId === filerId || group.aliasIds.includes(filerId)) {
      return group;
    }
  }
  return null;
}

/**
 * Map a filer id onto its durable canonical id when the id is a known alias.
 * Unknown ids pass through unchanged.
 */
export function resolveCanonicalFilerId(filerId: string | null | undefined): string | null {
  if (!filerId) return null;
  const group = memberMergeForFilerId(filerId);
  return group ? group.canonicalId : filerId;
}
