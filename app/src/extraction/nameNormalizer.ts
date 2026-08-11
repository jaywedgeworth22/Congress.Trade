import { applyMemberNameAlias } from '../shared/memberIdentity.ts';
import { houseAssetTypeCodePattern } from '../shared/assetTypes.ts';

export function isJunkAssetString(s: string | null | undefined): boolean {
  if (!s) return true;
  const str = String(s).trim();
  if (!str) return true;
  const lower = str.toLowerCase();
  if (
    lower.includes('unparsed historical filing') ||
    lower.includes('this filing was disclosed via scanned pdf') ||
    lower.includes('use link in ptr_link column to view the pdf') ||
    lower.includes('pdf disclosed filing')
  ) {
    return true;
  }
  const stripped = str.replace(/[\.\s\-\_\:\;\,\?\!\[\]\(\)]/g, '');
  if (stripped.length === 0) return true;
  if (/^[\.\_\-\s\]\)]+[a-z]?$/i.test(str)) return true;
  if (/[\.\_\-]{2,}/.test(str) && stripped.length <= 2) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Disclosure machinery -> cleaning_note
//
// Filings smuggle three kinds of form plumbing into the asset NAME field. All
// three are deterministic to parse, and all three belong in the existing
// `transactions.cleaning_note` column (rendered by plainCleaningNote() as the
// web "Notes" cell) rather than in the name a reader sees:
//
//   1. House PTR type codes  — "... CPN [CS] REDEMPTION"  (the code is already
//      stored separately in transactions.asset_type, so the copy in the name is
//      pure duplication).
//   2. Footnote markers      — "Us Treasury Bills Due 04/01/2021 [1][2]"  (a
//      pointer to a footnote we do not ingest: it carries no information at all).
//   3. Senate eFD's rigid instrument suffix — "Owens & Minor Rate/Coupon: 3.875%
//      Matures: 09/15/2021", plus the "... due 10/30/2014" variant.
//
// KNOWN LIMIT — DO NOT try to widen rule 3 into a general date/rate stripper.
// "Carroll Cnty Ga SCH Dist Go 5% 04/01/27 Ao (Muni) Rate/Coupon: 5.0% Matures:
// 04/01/2027" still reads "...Go 5% 04/01/27 Ao (Muni)" after the rigid suffix
// comes off, and that inline "5% 04/01/27" is genuinely part of how the muni is
// identified. Every rule below therefore needs an explicit keyword
// (Rate/Coupon:, Matures:, due) at the END of the string; a bare trailing rate
// or date is left alone. There is a regression test pinning exactly this.
// ---------------------------------------------------------------------------

/** Reuses the single source of truth for House codes — never re-list them. */
const HOUSE_TYPE_CODE_IN_NAME_RE = new RegExp(`\\s*\\[(?:${houseAssetTypeCodePattern()})\\]`, 'gi');
/** "[1]", "[12]" — a marker into a footnote table we do not ingest. */
const FOOTNOTE_MARKER_RE = /\s*\[\d{1,3}\](?=\s*(?:\[\d{1,3}\])*\s*$)/g;
/** Senate eFD suffix tokens, stripped one at a time off the END. */
const RATE_TOKEN_RE = /\s*[,;]?\s*Rate\/Coupon:\s*(\d{1,3}(?:\.\d+)?)\s*%\s*$/i;
const MATURES_TOKEN_RE = /\s*[,;]?\s*Matures:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s*$/i;
/** "... 5.125% due 10/30/2014" — rate first. */
const RATE_THEN_DUE_RE =
  /\s*[,;]?\s*(\d{1,3}(?:\.\d+)?)\s*%\s*[,;]?\s*\b(?:due|matures|maturing)\b\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s*$/i;
/** "... DUE 11/15/2035 5.000%" — date first, rate optional. */
const DUE_THEN_RATE_RE =
  /\s*[,;]?\s*\b(?:due|matures|maturing)\b\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s*(?:[,;]?\s*(\d{1,3}(?:\.\d+)?)\s*%)?\s*$/i;
/** "A (Exchanged) B" / "A (Exchanged) B (Received)" — both legs ARE disclosed. */
const EXCHANGE_RE = /^(.+?)\s*\(\s*Exchanged\s*\)\s*(.+)$/i;
const RECEIVED_SUFFIX_RE = /\s*\(\s*Received\s*\)\s*$/i;
/** A bare symbol ("BBT", "^MWE", "SNX") where a company name should be. */
const BARE_SYMBOL_RE = /^\^?[A-Z][A-Z0-9.\-]{0,5}$/;

export interface AssetNameCleanResult {
  /** Display name with the form plumbing removed (already cosmetically cleaned). */
  name: string;
  /** Plain-English fragments for `transactions.cleaning_note`, or null. */
  note: string | null;
  /**
   * Non-null when a human should look before this row is rewritten. Set rather
   * than guessed — the dry-run report buckets these separately so a backfill
   * never silently applies a change we are not sure about.
   */
  ambiguous: string | null;
}

/**
 * Split a raw disclosure asset name into the name a reader should see plus the
 * machinery that belongs in `cleaning_note`. Pure; safe to run on already-clean
 * names (it is a no-op and returns note: null).
 */
export function cleanAssetName(
  name: string | null | undefined,
  ticker?: string | null,
): AssetNameCleanResult {
  const original = cleanAssetString(name, ticker);
  if (!name || isJunkAssetString(name)) return { name: original, note: null, ambiguous: null };

  let str = String(name).trim();
  const notes: string[] = [];
  let ambiguous: string | null = null;

  // 1. House type codes.
  if (HOUSE_TYPE_CODE_IN_NAME_RE.test(str)) {
    HOUSE_TYPE_CODE_IN_NAME_RE.lastIndex = 0;
    str = str.replace(HOUSE_TYPE_CODE_IN_NAME_RE, ' ').trim();
    notes.push('removed disclosure type code from asset name');
  }
  HOUSE_TYPE_CODE_IN_NAME_RE.lastIndex = 0;

  // 2. Footnote markers (a trailing run of them, "[1][2]").
  if (FOOTNOTE_MARKER_RE.test(str)) {
    FOOTNOTE_MARKER_RE.lastIndex = 0;
    str = str.replace(FOOTNOTE_MARKER_RE, '').trim();
    notes.push('removed filing footnote markers from asset name');
  }
  FOOTNOTE_MARKER_RE.lastIndex = 0;

  // 3. Rigid instrument suffix. Peel Rate/Coupon: and Matures: off the end in
  //    whichever order they appear, then fall back to the "due <date>" forms.
  let rate: string | null = null;
  let matures: string | null = null;
  for (let i = 0; i < 4; i += 1) {
    const m = str.match(MATURES_TOKEN_RE);
    if (m) {
      matures = matures ?? m[1];
      str = str.slice(0, m.index).trim();
      continue;
    }
    const r = str.match(RATE_TOKEN_RE);
    if (r) {
      rate = rate ?? r[1];
      str = str.slice(0, r.index).trim();
      continue;
    }
    break;
  }
  if (!rate && !matures) {
    const rd = str.match(RATE_THEN_DUE_RE);
    if (rd) {
      rate = rd[1];
      matures = rd[2];
      str = str.slice(0, rd.index).trim();
    } else {
      const dr = str.match(DUE_THEN_RATE_RE);
      if (dr) {
        matures = dr[1];
        rate = dr[2] ?? null;
        str = str.slice(0, dr.index).trim();
      }
    }
  }
  if (rate && matures) notes.push(`${rate}% coupon, matures ${matures}`);
  else if (rate) notes.push(`${rate}% coupon`);
  else if (matures) notes.push(`matures ${matures}`);

  // 4. Exchange legs. Contrary to the PTR form, Senate/House exchange rows DO
  //    disclose both sides in one name field ("Praxair, Inc. (Exchanged) Linde
  //    plc"), so naming leg one and noting leg two invents nothing. The catch:
  //    `ticker` does not reliably point at leg one — "Aetna Inc. (Exchanged) CVS
  //    Health Corporation" carries AET, but "21st Century Fox Class A
  //    (Exchanged) The Walt Disney Company" carries DIS. Resolving that needs
  //    securities_ref, which a pure function has no access to, so the caller
  //    (the dry-run report) does the cross-check and this only flags the legs
  //    that are bare symbols rather than names.
  const ex = str.match(EXCHANGE_RE);
  if (ex) {
    const given = ex[1].trim();
    const received = ex[2].replace(RECEIVED_SUFFIX_RE, '').trim();
    if (given && received) {
      str = given;
      notes.push(`exchanged for ${received}`);
      if (BARE_SYMBOL_RE.test(given) || BARE_SYMBOL_RE.test(received)) {
        ambiguous = 'exchange leg is a bare symbol, not a company name';
      }
    }
  }

  const cleaned = cleanAssetString(str, ticker);
  if (!cleaned) {
    // Everything we stripped WAS the name. Keep the original and let a human look.
    return { name: original, note: null, ambiguous: 'stripping would leave an empty asset name' };
  }
  return { name: cleaned, note: notes.length ? notes.join('; ') : null, ambiguous };
}

export function cleanAssetString(name: string | null | undefined, ticker?: string | null): string {
  if (!name || isJunkAssetString(name)) return '';
  let str = name.trim();

  // Strip leading/trailing dot-leaders and orphan OCR trailing noise (e.g. "ARCC ..", ".....]", "....k")
  str = str.replace(/\s*\.{2,}[a-z0-9\]\)]*$/i, '');
  // A trailing "]" is OCR debris only when nothing opened it. Guarding on "["
  // stops the strip from mangling a real bracketed suffix into an unbalanced
  // one — it used to turn "Aspen Insurance Holdings Ltd [Ahl/Pc]" into
  // "... [Ahl/Pc", which reads as corruption rather than as a share class.
  if (!str.includes('[')) str = str.replace(/\s*\]+$/, '');
  str = str.replace(/^[.\s\)\-]+/, '');
  if (!str.includes(']')) str = str.replace(/^\[+\s*/, '');
  str = str.replace(/\s*\.{2,}\s*/g, ' ');

  // If the name is produced as exactly the ticker, return the uppercase ticker
  if (ticker && str.toLowerCase() === ticker.trim().toLowerCase()) {
    return ticker.toUpperCase();
  }

  // Strip state of incorporation suffix (e.g. "/DE/", "/DE", "/CA") only if it matches a US state code
  const STATES = new Set([
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
    "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
    "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
    "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
    "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY"
  ]);
  str = str.replace(/\/([a-zA-Z]{2})(?:\/|\b)/g, (match, code) => {
    if (STATES.has(code.toUpperCase())) {
      return " ";
    }
    return match;
  });
  str = str.replace(/\s{2,}/g, " ").trim();

  // 1. Remove trailing stock exchanges in parentheses (e.g. "(NYSE)", "(NASDAQ: AAPL)")
  str = str.replace(/\s*\([A-Z]+(?:\s*:\s*[A-Z]+)?\)\s*$/i, '');

  // 2. Remove trailing slash
  str = str.replace(/\/\s*$/g, '');

  // 3. Title case if the string is primarily ALL CAPS.
  const upperCount = (str.match(/[A-Z]/g) || []).length;
  const lowerCount = (str.match(/[a-z]/g) || []).length;
  
  if (upperCount > 0 && upperCount > lowerCount * 2) {
    let wordIndex = 0;
    str = str.replace(/[A-Za-z0-9]+/g, (txt) => {
      const isFirstWord = wordIndex++ === 0;
      const upper = txt.toUpperCase();
      if (upper === 'INC') return 'Inc.';
      if (upper === 'COM') return 'com';
      if (upper === 'CO') return 'Co.';
      if (upper === 'LTD') return 'Ltd.';
      if (upper === 'CORP') return 'Corp.';
      if (['THE', 'AND', 'FOR', 'OF', 'IN', 'ON', 'AT', 'TO'].includes(upper)) {
        return isFirstWord ? txt.charAt(0).toUpperCase() + txt.substring(1).toLowerCase() : txt.toLowerCase();
      }
      
      // Keep acronyms (e.g., IBM, CBS, LLC, ETF, USA) uppercase if 3 chars or fewer without vowels
      if (txt.length <= 3 && txt.toUpperCase() === txt && !/[AEIOU]/i.test(txt)) {
        return txt;
      }
      return txt.charAt(0).toUpperCase() + txt.substring(1).toLowerCase();
    });
  }

  // 4. Entity normalizations (case-insensitive)
  str = str.replace(/(?:\s*(?:-)?\s*Common Stock\b)/ig, '');
  str = str.replace(/\bAmazon\s+Com\s+Inc\.?\b/gi, 'Amazon.com, Inc.');
  str = str.replace(/\bAmazon\.com\s+Inc\.?\b/gi, 'Amazon.com, Inc.');
  str = str.replace(/\bMeta\s+Platforms\s+Inc\.?\b/gi, 'Meta Platforms, Inc.');
  str = str.replace(/\bINC(?:\.|\b)/gi, 'Inc.');
  str = str.replace(/\bL\.?L\.?C(?:\.|\b)/gi, 'LLC');
  str = str.replace(/\bL\.?P(?:\.|\b)/gi, 'LP');
  str = str.replace(/\bCORP(?:\.|\b)/gi, 'Corp.');
  str = str.replace(/\bCO(?:\.|\b)(?=\s|$)/gi, 'Co.'); // Only match "Co." at end of string or before space
  str = str.replace(/\bLTD(?:\.|\b)/gi, 'Ltd.');

  // Clean up any double spaces or spaces before punctuation
  str = str.replace(/\s+([.,])/g, '$1');
  str = str.replace(/\s{2,}/g, ' ');

  return str.trim();
}

export function cleanFilerName(name: string | null | undefined): string {
  if (!name) return '';
  let str = name.trim();

  // Strip standalone honorifics and professional titles wherever a source
  // embedded them in the member's name (for example, "Richard Dean Dr
  // McCormick" or "Neal Patrick MD, Facs Dunn"). Do not match substrings in
  // ordinary names such as Drake or Senatorial.
  str = str.replace(
    /(?:,\s*)?\b(?:DR|HON|MR|MRS|MS|REP|SEN|MD|FACS|PH\.?D\.?)\b(?:,\s*)?/gi,
    ' ',
  );
  
  // Strip "(Senator)" or ", Senator"
  str = str.replace(/\s*\(Senator\)\s*/gi, ' ');
  str = str.replace(/,\s*Senator\b/gi, ' ');

  // If it's formatted as "Last, First" (e.g. "Boozman, John" or "McCormick, David H.")
  if (/^[A-Za-z\-]+,\s*[A-Za-z\s.\-]+$/.test(str)) {
    const parts = str.split(',');
    str = parts[1].trim() + ' ' + parts[0].trim();
  }

  // Title case if the string is primarily ALL CAPS.
  const upperCount = (str.match(/[A-Z]/g) || []).length;
  const lowerCount = (str.match(/[a-z]/g) || []).length;
  if (upperCount > 0 && upperCount > lowerCount * 2) {
    str = str.toLowerCase().replace(/(^|\s|-|\.)\w/g, (c) => c.toUpperCase());
  }

  // Clean up any trailing commas, spaces, or stray periods
  str = str.replace(/[,\s.]+$/, '');
  str = str.replace(/\s{2,}/g, ' ');

  // Curated legal → preferred renames (e.g. Rohit Khanna → Ro Khanna).
  // Applied last so "Khanna, Rohit" is already flipped to "Rohit Khanna".
  str = applyMemberNameAlias(str.trim());

  return str.trim();
}

export function simplifyCompanyName(name: string): string {
  if (!name) return '';
  return name.toLowerCase()
    .replace(/[^\w\s]/g, '') // remove punctuation
    .replace(/\b(inc|corp|corporation|llc|plc|ltd|company|co)\b/g, '') // remove common suffixes
    .replace(/\s+/g, ' ')
    .trim();
}
