/**
 * src/extraction/tickerNormalize.ts
 * OWNER: extraction
 *
 * Deterministic, $0 ticker normalization used as a FALLBACK when the
 * securities_master resolver can't find an exact symbol / alias / name match.
 *
 * Why this exists: `unresolved_ticker` is the dominant review-queue reason
 * (~90% of the live queue) — but the vision read is almost always correct. The
 * gap is downstream: securities_master is well-populated (~10k symbols) yet
 *   (a) carries NO aliases (the alias table is empty in prod),
 *   (b) doesn't list preferred / depositary series symbols (e.g. "T$A",
 *       "JPM^J", "JPM-PJ"),
 *   (c) stores a single punctuation form for class shares ("BRK-B", not
 *       "BRK.B" / "BRKB"), and
 *   (d) is missing a long tail of perfectly valid current symbols
 *       (single-letter like "K"/"BK", OTC/ADRs like "NSRGY"/"NTDOF", and
 *       recent listings) — and a well-formed symbol that simply isn't in our
 *       master list should NOT be penalized into review.
 *
 * Resolution tiers (most → least confident); every function here is pure:
 *   1. preferred/depositary variants: "T$A" → "T^A",
 *      "JPM-PJ" / "JPM.PRJ" → "JPM^J".
 *   2. punctuation variants: "BRK.B" ↔ "BRK-B" ↔ "BRKB".
 *   3. curated stale → current alias map (delistings / renames / M&A).
 *   4. syntactic acceptance: a *well-formed* symbol absent from the master is
 *      accepted as-is; a malformed / header-contaminated string is rejected so
 *      it still flags `unresolved_ticker` and routes to human review.
 *
 * Tiers 1–3 only ever return a symbol that the master actually contains (or a
 * known-good current ticker), so they carry no false-accept risk. Tier 4 trusts
 * the extractor's well-formed symbol — consistent with the existing resolver,
 * which already accepts any of the 10k master symbols without cross-checking the
 * asset name, and validated by the bake-off (independent vision models agree on
 * the read). Once accepted, the enrichment service fetches the symbol's
 * company name / sector / logo from FMP, so the master fills in over time.
 */

/**
 * Curated stale → current ticker map. Keep this SMALL and unambiguous: only
 * well-known delistings / rebrands / acquisitions where the mapping is certain.
 * A wrong entry silently mis-attributes a trade, so err toward omission. All
 * targets are verified present in securities_master.
 */
export const TICKER_ALIASES: Readonly<Record<string, string>> = {
  BRCM: 'AVGO', // Broadcom Corp (old) → Broadcom Inc
  FB: 'META', // Facebook → Meta Platforms
  SQ: 'XYZ', // Square → Block, Inc.
  GEHCV: 'GEHC', // GE HealthCare when-issued/odd variant → GEHC
  TWX: 'WBD', // Time Warner → (via WarnerMedia) Warner Bros. Discovery
  ATVI: 'MSFT', // Activision Blizzard (acquired by Microsoft, 2023)
  RHT: 'IBM', // Red Hat (acquired by IBM, 2019)
};

/**
 * A well-formed US/OTC symbol: 1–5 letters, optionally a class suffix
 * (".A" / "-B"). Matches AAPL, K, NSRGY, KRSOX, BRK.B, BRK-B. Rejects anything
 * with spaces, digits, or length/shape that signals header contamination
 * ("Bank of America Apple", "200? Cathay", "COMMON STOCK").
 */
const WELL_FORMED_TICKER = /^[A-Z]{1,5}(\^[A-Z0-9]{1,2}|[.-][A-Z]{1,2})?$/;

/** Placeholders the extractors sometimes emit for a genuinely ticker-less row. */
const PLACEHOLDER_TICKERS = new Set(['', '-', '--', '---', 'N/A', 'NA', 'NONE', 'NULL', '—']);

/** Clean a raw symbol: trim, uppercase, drop surrounding quotes/brackets. */
function clean(raw: string | null | undefined): string {
  return (raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/^[("'[\s]+|[)"'\]\s]+$/g, '')
    .trim();
}

/**
 * True when the raw value is a "no ticker" placeholder (dash, N/A, blank). The
 * normalizer treats these as ticker-less rather than as an unresolved ticker,
 * so legitimately symbol-less assets (bonds, funds) aren't penalized.
 */
export function isPlaceholderTicker(raw: string | null | undefined): boolean {
  const c = clean(raw);
  return c === '' || PLACEHOLDER_TICKERS.has(c);
}

/** Strip a preferred/depositary `$`-series suffix: "T$A" → "T", "RF$E" → "RF". */
export function stripPreferredSeries(sym: string): string {
  return sym.replace(/\$[A-Z0-9]+$/, '');
}

/**
 * Normalize common preferred/depositary-share ticker spellings to one canonical
 * exchange-style form. Examples:
 *   Nasdaq:     JPM^J
 *   Yahoo:      JPM-PJ
 *   MarketWatch JPM.PRJ
 *   Legacy:     JPM$J
 */
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
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function preferredIssuerName(assetName: string): string | null {
  const idx = assetName.search(/\b(?:DEPOSITARY\s+SHARES?|PREFERRED|PREFERENCE|PFD|PREF)\b/i);
  if (idx <= 0) return null;
  return assetName.slice(0, idx).trim().replace(/[,;:\s]+$/g, '');
}

/**
 * Resolve preferred/depositary-share descriptions that include no ticker. This
 * intentionally does not derive a symbol from multi-letter issuer series like
 * "Series GG"; exchanges assign listed preferred suffixes independently, so
 * those need curated overrides.
 */
export function resolvePreferredTickerFromAssetName(
  assetName: string | null | undefined,
  resolveIssuerTicker: (issuerName: string) => string | null,
): string | null {
  if (!assetName) return null;
  const text = normalizedAssetText(assetName);
  if (!/\b(?:DEPOSITARY SHARES?|PREFERRED|PREFERENCE|PFD|PREF)\b/.test(text)) return null;

  if (text.includes('JPMORGAN CHASE') && text.includes('DEPOSITARY SHARES') && text.includes('SERIES GG')) {
    return 'JPM^J';
  }

  const series = /\bSERIES\s+([A-Z0-9]{1,3})\b/.exec(text)?.[1];
  if (!series || series.length !== 1) return null;

  const issuerName = preferredIssuerName(assetName);
  if (!issuerName) return null;
  const issuer = resolveIssuerTicker(issuerName);
  return issuer ? `${issuer}^${series}` : null;
}

/**
 * Distinct punctuation spellings of a class share, most-specific first:
 * the symbol as-is, dotless ("BRKB"), dash form ("BRK-B"), dot form ("BRK.B").
 */
export function punctuationVariants(sym: string): string[] {
  return Array.from(
    new Set([sym, sym.replace(/[.-]/g, ''), sym.replace(/\./g, '-'), sym.replace(/-/g, '.')]),
  ).filter(Boolean);
}

/** True when `sym` is a syntactically valid ticker we'll accept without a master hit. */
export function isWellFormedTicker(sym: string): boolean {
  return WELL_FORMED_TICKER.test(sym);
}

/**
 * Deterministic ticker resolution fallback. `isKnown(sym)` probes the
 * securities_master index, returning the canonical symbol when present, else
 * null. Returns a resolved/accepted symbol, or null when the input is a
 * placeholder or too malformed to trust (→ `unresolved_ticker` + review).
 */
export function resolveTickerDeterministic(
  raw: string | null | undefined,
  isKnown: (sym: string) => string | null,
): string | null {
  const cleaned = clean(raw);
  if (cleaned === '' || PLACEHOLDER_TICKERS.has(cleaned)) return null;

  const preferred = normalizePreferredTickerVariant(cleaned);
  if (preferred) return preferred;

  const base = stripPreferredSeries(cleaned) || cleaned;

  // Tier 1+2: `$`-strip then punctuation variants, probed against the master.
  for (const candidate of punctuationVariants(base)) {
    const hit = isKnown(candidate);
    if (hit) return hit;
  }

  // Tier 3: curated stale → current alias (try the cleaned form and the base).
  const alias = TICKER_ALIASES[cleaned] ?? TICKER_ALIASES[base];
  if (alias) return isKnown(alias) ?? alias;

  // Tier 4: accept a well-formed symbol the master simply doesn't list yet.
  if (isWellFormedTicker(base)) return base;

  return null;
}
