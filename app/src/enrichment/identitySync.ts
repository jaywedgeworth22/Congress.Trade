/**
 * src/enrichment/identitySync.ts
 *
 * Bioguide-driven identity sync for `filers`: backfills missing
 * resolved_bioguide_id on house/senate filers, computes each filer's
 * "campaign sign" display_name (the preferred public name — "Bernie Moreno"
 * not "Bernardo Moreno", "Ted Cruz" not "Rafael Edward Cruz"), and overwrites
 * party/state/district from the legislator's latest term for any resolved
 * filer (fixing missing Senator states and wrong MANUAL-* metadata). Filers
 * that never resolve to a bioguide (executive branch, MANUAL-* competitor
 * injects, blank-name rows) instead get a best-effort display_name cleaned
 * from full_name.
 *
 * Three separate lookups over the same congress-legislators roster
 * (src/enrichment/legislators.ts) drive resolution, tried in order:
 *   1. The PRIMARY map, keyed by normalized "first last" / "nickname last" /
 *      official_full — the same lookup runPhotoEnrichment already uses.
 *   2. The FALLBACK index, keyed by a first+last token pair extracted from
 *      the free-text filer name after stripping honorifics/ERM/years/
 *      suffixes (see legislators.fallbackNameKeys). Only counted as a match
 *      when it resolves to exactly one candidate — either because the
 *      filer's state matches that candidate's state, or because the filer
 *      has no state on file and the key is unambiguous on its own. Never a
 *      last-name-only guess.
 *   3. Nothing: resolved_bioguide_id is never set on a guess, and an
 *      already-set resolved_bioguide_id is never overwritten.
 *
 * Writes are batched (batchPrepared, 50 statements/D1 batch) the same way
 * committeeSync.ts does. dryRun returns the full plan (counts + first 50
 * sample changes) without writing anything.
 */

import type { Env } from '../shared/types.ts';
import { all, batchPrepared } from '../shared/db.ts';
import {
  fetchLegislatorIndexes,
  fallbackNameKeys,
  normName,
  type LegislatorIndexes,
  type LegislatorMatch,
} from './legislators.ts';
import { cleanFilerName } from '../extraction/nameNormalizer.ts';

export interface IdentityFilerRow {
  bioguide_id: string;
  chamber: string | null;
  full_name: string | null;
  party: string | null;
  state: string | null;
  district: string | null;
  resolved_bioguide_id: string | null;
  display_name: string | null;
}

export interface IdentityPlanChange {
  filerId: string;
  kind: 'resolved' | 'display-name' | 'fields' | 'cleaned';
  before: Partial<IdentityFilerRow>;
  after: Partial<IdentityFilerRow>;
}

export interface IdentityPlan {
  changes: IdentityPlanChange[];
  filersScanned: number;
  bioguideResolved: number;
  displayNamesSet: number;
  fieldsBackfilled: number;
  cleaned: number;
  unresolved: number;
}

/** Resolve a filer's bioguide via the primary name map (cleaned name, then raw name). Mirrors runPhotoEnrichment's lookup exactly. */
function resolvePrimary(fullName: string | null, primary: Map<string, LegislatorMatch>): LegislatorMatch | null {
  const cleaned = cleanFilerName(fullName);
  return primary.get(normName(cleaned || fullName)) ?? primary.get(normName(fullName)) ?? null;
}

/**
 * Resolve via the first+last fallback index, gated by state per the module
 * doc comment. Tries each fallback key derived from the raw filer name in
 * turn (first token + last token, then first token + last-two-tokens for a
 * multi-word surname) and returns the first key whose candidate set narrows
 * to exactly one legislator under the state rule.
 */
function resolveFallback(
  fullName: string | null,
  filerState: string | null,
  fallback: Map<string, LegislatorMatch[]>,
): LegislatorMatch | null {
  const keys = fallbackNameKeys(fullName);
  const state = (filerState ?? '').trim().toUpperCase();
  for (const key of keys) {
    const candidates = fallback.get(key);
    if (!candidates || candidates.length === 0) continue;
    if (state) {
      const stateMatches = candidates.filter((m) => (m.state ?? '').toUpperCase() === state);
      if (stateMatches.length === 1) return stateMatches[0];
    } else if (candidates.length === 1) {
      return candidates[0];
    }
  }
  return null;
}

/** The legislator's preferred public display name: official_full, else "nickname last", else "first last". */
function legislatorDisplayName(m: LegislatorMatch): string | null {
  if (m.officialFull && m.officialFull.trim()) return m.officialFull.trim();
  if (m.nickname && m.last) return `${m.nickname} ${m.last}`.trim();
  if (m.first && m.last) return `${m.first} ${m.last}`.trim();
  return null;
}

const HONORIFIC_CLEANUP_RE = /\b(?:HON|HONORABLE|DR|MR|MRS|MS|MD|FACS|REP|SEN)\b\.?,?/gi;
// "10.24..2022" / "8.12.2025"-style dotted date fragments, and "8-12-25"-style dashed ones.
const DATE_FRAGMENT_RE = /\b\d{1,2}\.\d{1,2}\.{1,2}\d{2,4}\b|\b\d{1,2}-\d{1,2}-\d{2,4}\b/g;
// "2021 ERM" or a bare standalone "ERM" marker.
const ERM_RE = /\b(?:\d{4}\s+)?ERM\b/gi;
const BARE_YEAR_RE = /\b(?:19|20)\d{2}\b/g;
const EMPTY_PARENS_RE = /\(\s*\)/g;

const SUFFIX_NORMALIZATION: Record<string, { display: string; comma: boolean }> = {
  jr: { display: 'Jr.', comma: true },
  sr: { display: 'Sr.', comma: true },
  ii: { display: 'II', comma: false },
  iii: { display: 'III', comma: false },
  iv: { display: 'IV', comma: false },
  v: { display: 'V', comma: false },
};

/** Title-case a string if it's primarily ALL CAPS (mirrors cleanFilerName/cleanAssetString's naive detector). */
function titleCaseIfShouting(str: string): string {
  const upperCount = (str.match(/[A-Z]/g) || []).length;
  const lowerCount = (str.match(/[a-z]/g) || []).length;
  if (upperCount > 0 && upperCount > lowerCount * 2) {
    return str.toLowerCase().replace(/(^|\s|-|\.)\w/g, (c) => c.toUpperCase());
  }
  return str;
}

/**
 * Best-effort display_name for a filer that never resolves to a bioguide
 * (executive branch, MANUAL-* competitor injects, blank-name rows). Strips
 * ERM/date/year noise and honorifics, flips "Last, First" (including a
 * multi-word "last" chunk, e.g. "Justice II, James Conley"), normalizes
 * generational-suffix casing/punctuation, title-cases ALL-CAPS input, and
 * collapses whitespace. Returns null for input that cleans down to nothing
 * (the known blank ' ' MANUAL- filer).
 */
export function fallbackCleanDisplayName(fullName: string | null | undefined): string | null {
  let str = String(fullName ?? '');
  if (!str.trim()) return null;

  str = str.replace(DATE_FRAGMENT_RE, ' ');
  str = str.replace(ERM_RE, ' ');
  str = str.replace(BARE_YEAR_RE, ' ');
  str = str.replace(EMPTY_PARENS_RE, ' ');
  str = str.replace(HONORIFIC_CLEANUP_RE, ' ');
  str = str.replace(/\s{2,}/g, ' ').trim();
  // Leading/trailing comma or whitespace only — NOT period, which a
  // generational-suffix normalization below may legitimately need to keep
  // ("Jr." at the very end).
  str = str.replace(/^[,\s]+|[,\s]+$/g, '').trim();

  if (!str) return null;

  // "Last[, multi-word ok], First [Suffix]" -> "First [Suffix] Last[, multi-word ok]",
  // unless what follows the comma is JUST a generational suffix (that's a
  // trailing-suffix comma on an already First-Last-ordered name, not a flip).
  const commaIdx = str.indexOf(',');
  if (commaIdx > -1 && str.indexOf(',', commaIdx + 1) === -1) {
    const before = str.slice(0, commaIdx).trim();
    const after = str.slice(commaIdx + 1).trim();
    const afterSuffix = SUFFIX_NORMALIZATION[after.toLowerCase().replace(/\.$/, '')];
    if (before && after) {
      if (afterSuffix) {
        str = afterSuffix.comma ? `${before}, ${afterSuffix.display}` : `${before} ${afterSuffix.display}`;
      } else {
        str = `${after} ${before}`;
      }
    }
  }

  // Normalize any remaining bare generational-suffix token's casing/punctuation
  // wherever it landed (the comma-flip above already handled the trailing-comma
  // case). Lookahead instead of a trailing \b: a `\b` immediately after an
  // optional period is unreliable (period is a non-word char, so there is no
  // boundary between it and end-of-string), which would otherwise make the
  // period backtrack out of the match and get orphaned.
  str = str.replace(/\b(jr|sr|ii|iii|iv|v)\.?(?=$|[\s,])/gi, (_m, suf: string) => {
    const norm = SUFFIX_NORMALIZATION[suf.toLowerCase()];
    return norm ? norm.display : _m;
  });

  str = titleCaseIfShouting(str);
  str = str.replace(/\s{2,}/g, ' ').trim();
  str = str.replace(/^[,\s]+|[,\s]+$/g, '').trim();

  return str || null;
}

/**
 * Pure planning step (no DB/network): decide resolved_bioguide_id backfills,
 * display_name writes, authoritative party/state/district overwrites, and
 * fallback-cleaned display names for unresolved filers. Idempotent — a
 * filer whose computed values already match what's stored produces no
 * change entry.
 */
export function planIdentitySync(
  filers: readonly IdentityFilerRow[],
  indexes: LegislatorIndexes,
): IdentityPlan {
  const changes: IdentityPlanChange[] = [];
  let bioguideResolved = 0;
  let displayNamesSet = 0;
  let fieldsBackfilled = 0;
  let cleaned = 0;
  let unresolved = 0;

  for (const f of filers) {
    let resolvedBioguide = f.resolved_bioguide_id;
    let newlyResolved = false;

    if (!resolvedBioguide && (f.chamber === 'house' || f.chamber === 'senate')) {
      const match = resolvePrimary(f.full_name, indexes.primary) ?? resolveFallback(f.full_name, f.state, indexes.fallback);
      if (match) {
        resolvedBioguide = match.bioguide;
        newlyResolved = true;
      }
    }

    if (resolvedBioguide) {
      const legislator = indexes.byBioguide.get(resolvedBioguide);
      if (!legislator) {
        // Bioguide known but not present in this fetch of the roster (stale
        // id, or a fetch that failed to include it) — nothing more we can
        // safely compute this run beyond the backfill itself.
        if (newlyResolved) {
          changes.push({
            filerId: f.bioguide_id,
            kind: 'resolved',
            before: { resolved_bioguide_id: f.resolved_bioguide_id },
            after: { resolved_bioguide_id: resolvedBioguide },
          });
          bioguideResolved++;
        }
        continue;
      }

      const displayName = legislatorDisplayName(legislator);
      const nextParty = legislator.party;
      const nextState = legislator.state;
      const nextDistrict = legislator.district;

      const displayChanged = displayName !== null && displayName !== f.display_name;
      const fieldsChanged =
        nextParty !== f.party || nextState !== f.state || nextDistrict !== f.district;

      if (newlyResolved || displayChanged || fieldsChanged) {
        changes.push({
          filerId: f.bioguide_id,
          kind: newlyResolved ? 'resolved' : displayChanged ? 'display-name' : 'fields',
          before: {
            resolved_bioguide_id: f.resolved_bioguide_id,
            display_name: f.display_name,
            party: f.party,
            state: f.state,
            district: f.district,
          },
          after: {
            resolved_bioguide_id: resolvedBioguide,
            display_name: displayName ?? f.display_name,
            party: nextParty,
            state: nextState,
            district: nextDistrict,
          },
        });
        if (newlyResolved) bioguideResolved++;
        if (displayChanged) displayNamesSet++;
        if (fieldsChanged) fieldsBackfilled++;
      }
    } else {
      unresolved++;
      const next = fallbackCleanDisplayName(f.full_name);
      if (next !== f.display_name) {
        changes.push({
          filerId: f.bioguide_id,
          kind: 'cleaned',
          before: { display_name: f.display_name },
          after: { display_name: next },
        });
        cleaned++;
      }
    }
  }

  return {
    changes,
    filersScanned: filers.length,
    bioguideResolved,
    displayNamesSet,
    fieldsBackfilled,
    cleaned,
    unresolved,
  };
}

export interface IdentitySyncResult {
  filersScanned: number;
  bioguideResolved: number;
  displayNamesSet: number;
  fieldsBackfilled: number;
  cleaned: number;
  unresolved: number;
  dryRun: boolean;
  /** Present only for dryRun: first 50 planned changes. */
  sample?: IdentityPlanChange[];
}

export async function runIdentitySync(
  env: Env,
  opts: { dryRun?: boolean } = {},
): Promise<IdentitySyncResult> {
  const dryRun = opts.dryRun === true;
  const indexes = await fetchLegislatorIndexes();
  const filers = await all<IdentityFilerRow>(
    env.DB,
    'SELECT bioguide_id, chamber, full_name, party, state, district, resolved_bioguide_id, display_name FROM filers',
  );
  const plan = planIdentitySync(filers, indexes);

  if (dryRun) {
    return {
      filersScanned: plan.filersScanned,
      bioguideResolved: plan.bioguideResolved,
      displayNamesSet: plan.displayNamesSet,
      fieldsBackfilled: plan.fieldsBackfilled,
      cleaned: plan.cleaned,
      unresolved: plan.unresolved,
      dryRun: true,
      sample: plan.changes.slice(0, 50),
    };
  }

  const statements = plan.changes.map((change) => {
    const after = change.after;
    if (change.kind === 'cleaned') {
      return env.DB.prepare('UPDATE filers SET display_name = ? WHERE bioguide_id = ?').bind(
        after.display_name ?? null,
        change.filerId,
      );
    }
    return env.DB.prepare(
      'UPDATE filers SET resolved_bioguide_id = ?, display_name = ?, party = ?, state = ?, district = ? WHERE bioguide_id = ?',
    ).bind(
      after.resolved_bioguide_id ?? null,
      after.display_name ?? null,
      after.party ?? null,
      after.state ?? null,
      after.district ?? null,
      change.filerId,
    );
  });
  for (let i = 0; i < statements.length; i += 50) {
    await batchPrepared(env.DB, statements.slice(i, i + 50));
  }

  return {
    filersScanned: plan.filersScanned,
    bioguideResolved: plan.bioguideResolved,
    displayNamesSet: plan.displayNamesSet,
    fieldsBackfilled: plan.fieldsBackfilled,
    cleaned: plan.cleaned,
    unresolved: plan.unresolved,
    dryRun: false,
  };
}
