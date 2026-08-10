/**
 * src/enrichment/legislators.ts
 *
 * Shared congress-legislators roster fetch + name-matching for member
 * enrichment (photos, committees, bioguide resolution, display names).
 * Extracted from admin/routes.ts's original buildLegislatorMap/normName so
 * app/src/enrichment/identitySync.ts can reuse the exact same roster and
 * matching rules without duplicating the fetch.
 *
 * Two lookup shapes are exposed over the same roster:
 *   - the PRIMARY map (`indexLegislators`): normalized "first last" /
 *     "nickname last" / official_full -> LegislatorMatch. This is the
 *     original photo-enrichment lookup, unchanged in behavior.
 *   - the FALLBACK index (`indexLegislatorFallback`): a first-token +
 *     last-token key (see `fallbackNameKeys`) for free-text names that carry
 *     a middle name/initial the primary keys don't account for (e.g. "Richard
 *     Dean McCormick" when official_full/nickname don't literally contain
 *     "Dean"), or a multi-word surname referenced by only its last word (e.g.
 *     "Matthew Robert Van Epps" vs. legislator last name "Van Epps"). Callers
 *     MUST gate fallback matches on state (see identitySync.ts) — this index
 *     alone can return multiple candidates for one key and is not a safe
 *     1:1 lookup on its own.
 */

import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';

export const LEGISLATOR_SOURCES = [
  'https://unitedstates.github.io/congress-legislators/legislators-current.json',
  'https://unitedstates.github.io/congress-legislators/legislators-historical.json',
];

/** Generational-suffix tokens dropped by both normalizers below. */
const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

/** Honorific/professional-title tokens dropped only by the fallback key (normName leaves these to the caller's own pre-cleaning). */
const HONORIFIC_TOKENS = new Set(['hon', 'honorable', 'dr', 'mr', 'mrs', 'ms', 'md', 'facs']);

/**
 * Normalize a politician name for matching: lowercase, strip punctuation, drop
 * middle initials (single letters) and suffixes. "Ron L Wyden" -> "ron wyden".
 */
export function normName(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !NAME_SUFFIXES.has(t))
    .join(' ')
    .trim();
}

export interface LegislatorTerm {
  type?: string;
  party?: string;
  state?: string;
  district?: number | string | null;
  start?: string;
  end?: string;
}

export interface Legislator {
  id?: { bioguide?: string };
  name?: { first?: string; last?: string; official_full?: string; nickname?: string };
  terms?: LegislatorTerm[];
}

export interface LegislatorMatch {
  bioguide: string;
  party: string | null;
  state: string | null;
  district: string | null;
  /** congress-legislators name.official_full — the preferred public display name. */
  officialFull: string | null;
  nickname: string | null;
  first: string | null;
  last: string | null;
}

export function latestLegislatorTerm(terms: LegislatorTerm[] | undefined): LegislatorTerm | undefined {
  return (terms ?? []).slice().sort((a, b) => String(b.start ?? '').localeCompare(String(a.start ?? '')))[0];
}

function toMatch(leg: Legislator): LegislatorMatch | null {
  const bio = leg.id?.bioguide;
  if (!bio) return null;
  const term = latestLegislatorTerm(leg.terms);
  const n = leg.name ?? {};
  return {
    bioguide: bio,
    party: term?.party ?? null,
    state: term?.state ?? null,
    district: term?.district == null ? null : String(term.district),
    officialFull: n.official_full ?? null,
    nickname: n.nickname ?? null,
    first: n.first ?? null,
    last: n.last ?? null,
  };
}

/**
 * Pure: build the normalized-name -> legislator metadata map from an
 * already-fetched legislator list. Earlier entries win ties (callers should
 * pass the current roster before the historical one, as `buildLegislatorMap`
 * does, so active members win over past holders of a similar name).
 */
export function indexLegislators(list: readonly Legislator[]): Map<string, LegislatorMatch> {
  const map = new Map<string, LegislatorMatch>();
  for (const leg of list) {
    const match = toMatch(leg);
    if (!match) continue;
    const n = leg.name ?? {};
    const candidates = [
      n.first && n.last ? `${n.first} ${n.last}` : '',
      n.nickname && n.last ? `${n.nickname} ${n.last}` : '',
      n.official_full ?? '',
    ];
    for (const raw of candidates) {
      const k = normName(raw);
      if (k && !map.has(k)) map.set(k, match); // current list is loaded first; it wins
    }
  }
  return map;
}

/**
 * Tokens usable for the first+last fallback key: lowercase, punctuation
 * stripped, honorifics (Hon/Honorable/Dr/Mr/Mrs/Ms/MD/FACS) dropped,
 * generational suffixes dropped, a literal "ERM" token dropped, and any bare
 * 4-digit year dropped (executive filer rows carry things like "2021 ERM" or
 * a trailing disclosure year that must not become part of a name key).
 */
export function fallbackNameTokens(raw: string | null | undefined): string[] {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .filter((t) => !HONORIFIC_TOKENS.has(t))
    .filter((t) => !NAME_SUFFIXES.has(t))
    .filter((t) => t !== 'erm')
    .filter((t) => !/^\d{4}$/.test(t));
}

/**
 * First+last fallback key candidates for a free-text name: the first token
 * paired with the last token, and (when at least 3 tokens remain) the first
 * token paired with the last TWO tokens joined — the second form is what lets
 * a multi-word surname ("Van Epps") match whether the query used the whole
 * surname or, symmetrically, lets a legislator whose registered name is only
 * "First Last" still match a query that carries an extra middle name/word
 * before that last name. Returns [] when fewer than 2 usable tokens remain
 * (never a wildcard).
 */
export function fallbackNameKeys(raw: string | null | undefined): string[] {
  const tokens = fallbackNameTokens(raw);
  if (tokens.length < 2) return [];
  const first = tokens[0];
  const keys = [`${first} ${tokens[tokens.length - 1]}`];
  if (tokens.length >= 3) {
    keys.push(`${first} ${tokens.slice(-2).join(' ')}`);
  }
  return [...new Set(keys)];
}

/**
 * Pure: index legislators by their first+last fallback key(s) (derived from
 * first+last, nickname+last, and official_full — the same three candidate
 * strings the primary map uses). Multiple legislators can share a key (e.g.
 * two different people who both key to "james banks" in different states) —
 * this index intentionally keeps every candidate; callers MUST disambiguate
 * (state match, or a unique candidate when the query has no state) before
 * trusting a hit. See identitySync.ts's resolveFallbackBioguide.
 */
export function indexLegislatorFallback(list: readonly Legislator[]): Map<string, LegislatorMatch[]> {
  const idx = new Map<string, LegislatorMatch[]>();
  for (const leg of list) {
    const match = toMatch(leg);
    if (!match) continue;
    const n = leg.name ?? {};
    const keys = new Set<string>();
    for (const k of fallbackNameKeys(n.first && n.last ? `${n.first} ${n.last}` : '')) keys.add(k);
    for (const k of fallbackNameKeys(n.nickname && n.last ? `${n.nickname} ${n.last}` : '')) keys.add(k);
    for (const k of fallbackNameKeys(n.official_full ?? '')) keys.add(k);
    for (const key of keys) {
      const existing = idx.get(key);
      if (existing) {
        if (!existing.some((m) => m.bioguide === match.bioguide)) existing.push(match);
      } else {
        idx.set(key, [match]);
      }
    }
  }
  return idx;
}

/** Index legislators by bioguide id (first list entry wins per id — current roster loaded first). */
export function indexLegislatorsByBioguide(list: readonly Legislator[]): Map<string, LegislatorMatch> {
  const idx = new Map<string, LegislatorMatch>();
  for (const leg of list) {
    const match = toMatch(leg);
    if (!match || idx.has(match.bioguide)) continue;
    idx.set(match.bioguide, match);
  }
  return idx;
}

async function fetchAllLegislators(): Promise<Legislator[]> {
  const out: Legislator[] = [];
  for (const url of LEGISLATOR_SOURCES) {
    const res = await trackedFetch(
      url,
      {
        headers: {
          'user-agent': 'congress-feed/0.1 (+https://congress.trade)',
          accept: 'application/json',
        },
      },
      { service: 'member-enrichment', operation: 'fetch-legislator-roster' },
    );
    if (!res.ok) continue;
    out.push(...((await res.json()) as Legislator[]));
  }
  return out;
}

/** Fetch + build the normalized-name -> legislator metadata map from the live hosted JSON. */
export async function buildLegislatorMap(): Promise<Map<string, LegislatorMatch>> {
  return indexLegislators(await fetchAllLegislators());
}

export interface LegislatorIndexes {
  /** normalized "first last" / "nickname last" / official_full -> match. */
  primary: Map<string, LegislatorMatch>;
  /** first+last fallback key(s) -> candidate matches (needs state gating). */
  fallback: Map<string, LegislatorMatch[]>;
  /** bioguide id -> match, for filers that already carry a resolved id. */
  byBioguide: Map<string, LegislatorMatch>;
}

/** Fetch the roster once and build all three lookup shapes over it. */
export async function fetchLegislatorIndexes(): Promise<LegislatorIndexes> {
  const list = await fetchAllLegislators();
  return {
    primary: indexLegislators(list),
    fallback: indexLegislatorFallback(list),
    byBioguide: indexLegislatorsByBioguide(list),
  };
}
