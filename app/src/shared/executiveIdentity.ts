/**
 * Executive filer identity helpers.
 *
 * Competitor injects previously mapped by LAST NAME ONLY (e.g. any "McCormick"
 * → EXEC-MCCORMICK), which mis-attributed House members onto cabinet slots.
 * Resolution here requires a full-name / alias match, never bare last name.
 */

export interface CuratedExecutive {
  filerId: string;
  fullName: string;
  /** Regex against OGE PDF filenames (case-insensitive). */
  filenamePattern: RegExp;
  /** Normalized full-name aliases used for competitor payloads. */
  nameAliases: readonly string[];
  party: 'R' | 'D' | null;
  photoUrl: string | null;
}

const COMMONS_THUMB = 'https://upload.wikimedia.org/wikipedia/commons/thumb';

/** Curated PAS / President / VP filers we pin to stable EXEC-* ids. */
export const CURATED_EXECUTIVES: readonly CuratedExecutive[] = [
  {
    filerId: 'EXEC-DJT',
    fullName: 'Donald J. Trump',
    filenamePattern: /trump/i,
    nameAliases: ['donald j trump', 'donald trump', 'trump donald j', 'trump donald'],
    party: 'R',
    photoUrl: `${COMMONS_THUMB}/1/16/Official_Presidential_Portrait_of_President_Donald_J._Trump_%282025%29.jpg/500px-Official_Presidential_Portrait_of_President_Donald_J._Trump_%282025%29.jpg`,
  },
  {
    filerId: 'EXEC-JDV',
    fullName: 'J.D. Vance',
    filenamePattern: /vance/i,
    nameAliases: ['j d vance', 'jd vance', 'james david vance', 'vance j d', 'vance jd'],
    party: 'R',
    photoUrl: `${COMMONS_THUMB}/f/f3/January_2025_Official_Vice_Presidential_Portrait_of_JD_Vance.jpg/500px-January_2025_Official_Vice_Presidential_Portrait_of_JD_Vance.jpg`,
  },
  {
    filerId: 'EXEC-BESSENT',
    fullName: 'Scott Bessent',
    filenamePattern: /bessent/i,
    nameAliases: ['scott bessent', 'bessent scott'],
    party: 'R',
    photoUrl: null,
  },
  {
    filerId: 'EXEC-MCMAHON',
    fullName: 'Linda McMahon',
    filenamePattern: /mcmahon/i,
    nameAliases: ['linda mcmahon', 'linda e mcmahon', 'mcmahon linda', 'mcmahon linda e'],
    party: 'R',
    photoUrl: null,
  },
  {
    filerId: 'EXEC-CWRIGHT',
    fullName: 'Chris Wright',
    filenamePattern: /\bwright\b/i,
    // Require Chris/Christopher — bare "Wright" is too common.
    nameAliases: ['chris wright', 'christopher wright', 'wright chris', 'wright christopher'],
    party: 'R',
    photoUrl: null,
  },
  {
    filerId: 'EXEC-MCCORMICK',
    fullName: 'David McCormick',
    filenamePattern: /david[-\s.]*mccormick|mccormick[-\s,]*david|dave[-\s.]*mccormick/i,
    // Explicitly NOT "Rich McCormick" (House GA).
    nameAliases: ['david mccormick', 'dave mccormick', 'mccormick david', 'mccormick dave'],
    party: 'R',
    photoUrl: null,
  },
  {
    filerId: 'EXEC-LUTNICK',
    fullName: 'Howard Lutnick',
    filenamePattern: /lutnick/i,
    nameAliases: ['howard lutnick', 'lutnick howard'],
    party: 'R',
    photoUrl: null,
  },
  {
    filerId: 'EXEC-JRB',
    fullName: 'Joseph R. Biden',
    filenamePattern: /biden/i,
    nameAliases: ['joseph r biden', 'joe biden', 'joseph biden', 'biden joseph', 'biden joe'],
    party: 'D',
    photoUrl: `${COMMONS_THUMB}/6/68/Joe_Biden_presidential_portrait.jpg/500px-Joe_Biden_presidential_portrait.jpg`,
  },
  {
    filerId: 'EXEC-KDH',
    fullName: 'Kamala D. Harris',
    filenamePattern: /harris/i,
    nameAliases: ['kamala d harris', 'kamala harris', 'harris kamala'],
    party: 'D',
    photoUrl: `${COMMONS_THUMB}/4/41/Kamala_Harris_Vice_Presidential_Portrait.jpg/500px-Kamala_Harris_Vice_Presidential_Portrait.jpg`,
  },
];

/** Collapse a person name for alias comparison. */
export function normalizePersonName(raw: string | null | undefined): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(jr|sr|ii|iii|iv|md|phd)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Map a free-text person name to a curated EXEC-* id only when the full name
 * (or an explicit alias) matches. Bare last-name matches are rejected.
 */
export function resolveExecutiveFilerIdFromName(rawName: string | null | undefined): string | null {
  const norm = normalizePersonName(rawName);
  if (!norm || norm.split(' ').length < 2) return null;
  for (const exec of CURATED_EXECUTIVES) {
    if (exec.nameAliases.some((a) => a === norm)) return exec.filerId;
    // Allow "First Middle Last" when alias is "First Last"
    for (const alias of exec.nameAliases) {
      const aParts = alias.split(' ');
      const nParts = norm.split(' ');
      if (aParts.length >= 2 && nParts.length >= 2) {
        if (aParts[0] === nParts[0] && aParts[aParts.length - 1] === nParts[nParts.length - 1]) {
          return exec.filerId;
        }
      }
    }
  }
  return null;
}

/** True when this filer_id is an executive synthetic id. */
export function isExecutiveFilerId(filerId: string | null | undefined): boolean {
  return typeof filerId === 'string' && filerId.startsWith('EXEC-');
}

/**
 * Best-effort asset label from competitor raw JSON / free text.
 * Prefer notes / issuer description over the literal "Unknown".
 */
export function assetNameFromCompetitorPayload(
  raw: unknown,
  fallbackTicker?: string | null,
): string {
  let notes = '';
  let issuer = '';
  let asset = '';
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    notes = String(o.notes ?? o.Note ?? o.description ?? o.assetDescription ?? '').trim();
    issuer = String(o.issuer ?? o.Issuer ?? '').trim();
    asset = String(o.asset ?? o.assetName ?? o.Asset ?? o.ticker_name ?? '').trim();
  } else if (typeof raw === 'string') {
    try {
      return assetNameFromCompetitorPayload(JSON.parse(raw), fallbackTicker);
    } catch {
      notes = raw.trim();
    }
  }
  const fromNotes = notes
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !/^rate\/coupon/i.test(l) && !/^matures?:/i.test(l));
  const candidate = (fromNotes || asset || (issuer && !/^(self|spouse|joint|undisclosed)$/i.test(issuer) ? issuer : '') || fallbackTicker || '').trim();
  if (!candidate || /^unknown$/i.test(candidate)) return fallbackTicker?.trim() || 'Unknown';
  // Cap for UI; full notes remain in raw_text.
  return candidate.length > 200 ? `${candidate.slice(0, 197)}…` : candidate;
}
