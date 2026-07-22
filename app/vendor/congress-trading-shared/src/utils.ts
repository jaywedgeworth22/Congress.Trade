import type { MktCapBucket, TickerAliasResolution } from "./types";
import {
  MKT_CAP_THRESHOLDS,
  TICKER_ALIASES,
  TICKER_RENAMES,
  TICKER_ACQUISITIONS,
} from "./constants";

// ---- Ticker normalization ----

export const WELL_FORMED_TICKER = /^[A-Z]{1,5}(\^[A-Z0-9]{1,2}|[.-][A-Z]{1,2})?$/;

const PLACEHOLDER_TICKERS = new Set(["", "-", "--", "---", "N/A", "NA", "NONE", "NULL", "—"]);

/** Clean a raw symbol: trim, uppercase, drop surrounding quotes/brackets. */
export function clean(raw: string | null | undefined): string {
  return (raw ?? "")
    .trim()
    .toUpperCase()
    .replace(/^[("'[\s]+|[)"'\]\s]+$/g, "")
    .trim();
}

/** Normalize a raw ticker string: uppercase, strip whitespace, validate format. */
export function normalizeTicker(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().toUpperCase();
  if (!WELL_FORMED_TICKER.test(cleaned)) return null;
  return cleaned;
}

/** True when the raw value is a "no ticker" placeholder (dash, N/A, blank). */
export function isPlaceholderTicker(raw: string | null | undefined): boolean {
  const c = clean(raw);
  return c === "" || PLACEHOLDER_TICKERS.has(c);
}

/** Strip a preferred/depositary `$`-series suffix: "T$A" → "T", "RF$E" → "RF". */
export function stripPreferredSeries(sym: string): string {
  return sym.replace(/\$[A-Z0-9]+$/, "");
}

/** Normalize common preferred/depositary-share ticker spellings. */
export function normalizePreferredTickerVariant(raw: string | null | undefined): string | null {
  const sym = clean(raw);
  if (!sym) return null;

  let m = /^([A-Z]{1,5})\^([A-Z0-9]{1,2})$/.exec(sym);
  if (m) return `${m[1]}^${m[2]}`;

  m = /^([A-Z]{1,5})\$([A-Z0-9]{1,2})$/.exec(sym);
  if (m) return `${m[1]}^${m[2]}`;

  m = /^([A-Z]{1,5})-P([A-Z0-9])$/.exec(sym);
  if (m) return `${m[1]}^${m[2]}`;

  m = /^([A-Z]{1,5})[.-]PR([A-Z0-9])$/.exec(sym);
  if (m) return `${m[1]}^${m[2]}`;

  m = /^([A-Z]{1,5})\s+PR\s+([A-Z0-9])$/.exec(sym);
  if (m) return `${m[1]}^${m[2]}`;

  m = /^([A-Z]{1,5})\s+P(?:R)?([A-Z0-9])$/.exec(sym);
  if (m) return `${m[1]}^${m[2]}`;

  return null;
}

function normalizedAssetText(value: string): string {
  return value
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function preferredIssuerName(assetName: string): string | null {
  const idx = assetName.search(/\b(?:DEPOSITARY\s+SHARES?|PREFERRED|PREFERENCE|PFD|PREF)\b/i);
  if (idx <= 0) return null;
  return assetName.slice(0, idx).trim().replace(/[,;:\s]+$/g, "");
}

/** Resolve preferred/depositary-share descriptions that include no ticker. */
export function resolvePreferredTickerFromAssetName(
  assetName: string | null | undefined,
  resolveIssuerTicker: (issuerName: string) => string | null,
): string | null {
  if (!assetName) return null;
  const text = normalizedAssetText(assetName);
  if (!/\b(?:DEPOSITARY SHARES?|PREFERRED|PREFERENCE|PFD|PREF)\b/.test(text)) return null;

  if (text.includes("JPMORGAN CHASE") && text.includes("DEPOSITARY SHARES") && text.includes("SERIES GG")) {
    return "JPM^J";
  }

  const series = /\bSERIES\s+([A-Z0-9]{1,3})\b/.exec(text)?.[1];
  if (!series || series.length !== 1) return null;

  const issuerName = preferredIssuerName(assetName);
  if (!issuerName) return null;
  const issuer = resolveIssuerTicker(issuerName);
  return issuer ? `${issuer}^${series}` : null;
}

/** Distinct share-class punctuation variants. */
export function punctuationVariants(sym: string): string[] {
  return Array.from(
    new Set([sym, sym.replace(/[.-]/g, ""), sym.replace(/\./g, "-"), sym.replace(/-/g, ".")]),
  ).filter(Boolean);
}

/** True when `sym` is a syntactically valid ticker we'll accept without a master hit. */
export function isWellFormedTicker(sym: string): boolean {
  return WELL_FORMED_TICKER.test(sym);
}

/** Fallback ticker resolver logic. */
export function resolveTickerDeterministic(
  raw: string | null | undefined,
  isKnown: (sym: string) => string | null,
): string | null {
  const cleaned = clean(raw);
  if (cleaned === "" || PLACEHOLDER_TICKERS.has(cleaned)) return null;

  const preferred = normalizePreferredTickerVariant(cleaned);
  if (preferred) return preferred;

  const base = stripPreferredSeries(cleaned) || cleaned;

  for (const candidate of punctuationVariants(base)) {
    const hit = isKnown(candidate);
    if (hit) return hit;
  }

  const aliasCleaned = resolveContinuousTicker(cleaned);
  if (aliasCleaned !== cleaned) return isKnown(aliasCleaned) ?? aliasCleaned;

  const aliasBase = resolveContinuousTicker(base);
  if (aliasBase !== base) return isKnown(aliasBase) ?? aliasBase;

  if (isWellFormedTicker(base)) return base;

  return null;
}

/**
 * Resolve any curated ticker alias to its current ticker — renames AND acquisitions alike.
 *
 * This is IDENTITY/display resolution: it answers "what does this old ticker map to now?" and
 * is the right call for de-duplicating a securities master or rendering a current symbol. When
 * the corporate-action class matters — e.g. point-in-time return attribution, where an
 * acquired-and-delisted position must NOT inherit the acquirer's later price history — use
 * `classifyTickerAlias()` or the renames-only `resolveContinuousTicker()` instead.
 */
export function resolveTickerAlias(
  ticker: string,
  aliases: Readonly<Record<string, string>> = TICKER_ALIASES,
): string {
  const normalized = normalizeTicker(ticker) ?? ticker.trim().toUpperCase();
  return aliases[normalized] ?? normalized;
}

/**
 * Classify a ticker alias as a continuous `rename` or a discontinuous `acquisition`, returning
 * the normalized source, its target, and the class — or `null` when the ticker is not a known
 * alias source (i.e. it is already current, or unknown).
 *
 * The class is what point-in-time (PIT) logic needs: `rename` targets share a continuous price
 * series (folding old→new is correct), whereas `acquisition` sources were delisted at the deal
 * and their series ends there (the position should be treated as closed, not rolled into the
 * acquirer's ongoing series). `renames` is checked before `acquisitions`; the two curated maps
 * are disjoint on their SOURCE keys by construction, so ordering only matters if a caller passes
 * overlapping maps.
 *
 * Resolution is SINGLE-HOP and non-transitive: a source maps directly to its curated current
 * target with no chaining. The curated maps are intentionally non-chained (no target is also a
 * source), so a compound history (rename X→Y, then Y acquired→Z) is not representable here and
 * would need a richer model — see docs/rollouts/2026-07-05-ticker-alias-rename-vs-acquisition.md.
 */
export function classifyTickerAlias(
  ticker: string,
  opts?: {
    renames?: Readonly<Record<string, string>>;
    acquisitions?: Readonly<Record<string, string>>;
  },
): TickerAliasResolution | null {
  const renames = opts?.renames ?? TICKER_RENAMES;
  const acquisitions = opts?.acquisitions ?? TICKER_ACQUISITIONS;
  const from = normalizeTicker(ticker) ?? ticker.trim().toUpperCase();
  const renamed = renames[from];
  if (renamed !== undefined) return { from, to: renamed, class: "rename" };
  const acquired = acquisitions[from];
  if (acquired !== undefined) return { from, to: acquired, class: "acquisition" };
  return null;
}

/**
 * PIT-safe ticker resolution: fold ONLY continuous renames (e.g. FB→META) to the current
 * ticker and leave acquisition sources (ATVI, RHT, …) untouched, so downstream point-in-time
 * logic keeps a delisted series distinct from its acquirer's. Contrast with `resolveTickerAlias`,
 * which folds every alias for pure identity/display resolution.
 */
export function resolveContinuousTicker(
  ticker: string,
  renames: Readonly<Record<string, string>> = TICKER_RENAMES,
): string {
  const normalized = normalizeTicker(ticker) ?? ticker.trim().toUpperCase();
  return renames[normalized] ?? normalized;
}

// ---- Market cap bucket ----

/** Compute the market-cap bucket from a dollar value. */
export function marketCapBucket(
  n: number | null | undefined,
): MktCapBucket | null {
  if (n == null || !Number.isFinite(n) || n <= 0) return null;
  if (n >= MKT_CAP_THRESHOLDS.MEGA) return "mega";
  if (n >= MKT_CAP_THRESHOLDS.LARGE) return "large";
  if (n >= MKT_CAP_THRESHOLDS.MID) return "mid";
  if (n >= MKT_CAP_THRESHOLDS.SMALL) return "small";
  if (n >= MKT_CAP_THRESHOLDS.MICRO) return "micro";
  return "nano";
}

// ---- Amount bracket midpoint ----

/** Compute the midpoint of a STOCK Act dollar-amount bracket. */
export function bracketMidpoint(
  min: number | null,
  max: number | null,
): number {
  if (max != null && min != null) return (min + max) / 2;
  if (min != null) return min;
  return 0;
}

// ---- Date helpers ----

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Check if a string is a valid YYYY-MM-DD date. */
export function isIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Days between two YYYY-MM-DD strings. */
export function daysBetween(a: string, b: string): number {
  const da = new Date(a + "T00:00:00Z");
  const db = new Date(b + "T00:00:00Z");
  return Math.round((db.getTime() - da.getTime()) / 86_400_000);
}

// ---- Ref merging ----

/** Merge two partial refs, preferring the second (later/more authoritative) for non-null fields. */
export function mergeRefs<T extends Record<string, unknown>>(
  a: Partial<T> | null | undefined,
  b: Partial<T> | Record<string, unknown> | null | undefined,
): Partial<T> {
  const result: Record<string, unknown> = { ...(a ?? {}) };
  if (b) {
    for (const [k, v] of Object.entries(b)) {
      if (v !== null && v !== undefined) result[k] = v;
    }
  }
  return result as Partial<T>;
}



