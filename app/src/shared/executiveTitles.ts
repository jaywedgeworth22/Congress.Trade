/**
 * src/shared/executiveTitles.ts
 *
 * Curated `filerId -> title` map for executive-branch (`chamber='executive'`)
 * filers. Neither the OGE ingestion source nor the `filings`/`filers` schema
 * captures a filer's agency/position anywhere (see scout report
 * scout2-name-surfaces-exec.md §3) — `full_name` and `filer_id` are the only
 * identity signals we have. This map fills that gap for display purposes
 * only; it is never written back to the DB.
 *
 * Scope: only the executive filers that actually carry live transactions in
 * production (scout2-prod-data.md §3 — 21 of 152 `EXEC-*` rows have
 * `tx_count > 0`; the rest are dormant duplicate/near-empty rows from a
 * separate "-YYYY-ERM" ingestion pass and are omitted here). Where the same
 * person has both a base id and one or more `-ERM`/dated-suffix duplicate
 * ids in the roster, every variant is mapped to the same title, since the
 * identity-dedupe merge may pick any of them as canonical.
 *
 * Anything not in this map falls back to 'Executive Branch' at display time
 * (see {@link executiveTitleFor}) — never guess a title here without
 * verifying it first.
 */

export const EXECUTIVE_TITLES: Readonly<Record<string, string>> = {
  // Donald J. Trump — President
  'EXEC-DJT': 'President',

  // Scott Bessent — Treasury Secretary
  'EXEC-BESSENT': 'Treasury Secretary',

  // Chris Wright — Energy Secretary
  'EXEC-CWRIGHT': 'Energy Secretary',

  // Linda McMahon — Education Secretary
  'EXEC-MCMAHON': 'Education Secretary',

  // Barbara M. Barrett — Secretary of the Air Force (2020-2021)
  'EXEC-BARBARA-M-BARRETT-2021-ERM': 'Secretary of the Air Force',
  'EXEC-BARBARA-M-BARRETT': 'Secretary of the Air Force',
  'EXEC-BABARA-M-BARRETT': 'Secretary of the Air Force', // typo'd duplicate filer id

  // Alex M. Azar II — HHS Secretary (2018-2021)
  'EXEC-ALEX-M-AZAR-2021-ERM': 'HHS Secretary',

  // Antony J. Blinken — Secretary of State (2021-2025)
  'EXEC-ANTHONY-J-BLINKEN-2025-ERM': 'Secretary of State',
  'EXEC-ANTHONY-J-BLINKEN': 'Secretary of State',

  // Lloyd Austin — Defense Secretary (2021-2025)
  'EXEC-LLOYD-AUSTIN-2025-ERM': 'Defense Secretary',
  'EXEC-LLOYD-AUSTIN': 'Defense Secretary',

  // Eric S. Lander — OSTP Director (2021-2022)
  'EXEC-ERIC-S-LANDER-2022-ERM': 'OSTP Director',
  'EXEC-ERIC-S-LANDER': 'OSTP Director',

  // Michael J. Kratsios — OSTP Director (2025-present)
  'EXEC-MICHAEL-J-KRATSIOS': 'OSTP Director',
  'EXEC-MICHAEL-KRATSIOS': 'OSTP Director',

  // Adewale (Wally) Adeyemo — Deputy Treasury Secretary (2021-2025)
  'EXEC-ADEWALE-ADEYEMO': 'Deputy Treasury Secretary',
  'EXEC-ADEWALE-ADEYEMO-2025-ERM': 'Deputy Treasury Secretary', // gitleaks:allow — filer id, not a key

  // Tommy Beaudreau — Deputy Interior Secretary (2021-2023)
  'EXEC-TOMMY-BEAUDREAU': 'Deputy Interior Secretary',
  'EXEC-TOMMY-BEAUDREAU-2023-ERM': 'Deputy Interior Secretary', // gitleaks:allow — filer id, not a key

  // Frank J. Bisignano — Social Security Commissioner (2025-present)
  'EXEC-FRANK-J-BISIGNANO': 'Social Security Commissioner',

  // Sean Duffy — Transportation Secretary (2025-present)
  'EXEC-SEAN-DUFFY': 'Transportation Secretary',

  // David McCormick — U.S. Senator (PA); files an executive-style OGE
  // disclosure alongside his Senate one (see prod-data scout §2 "mccormick"
  // cluster — same bioguide M001243 as the Senate filer rows).
  'EXEC-MCCORMICK': 'U.S. Senator (PA)',

  // Christine Abizaid — NCTC Director (2021-2024)
  'EXEC-CHRISTINE-ABIZAID': 'NCTC Director',

  // Scott A. Kupor — OPM Director (2025-present)
  'EXEC-SCOTT-A-KUPOR': 'OPM Director',

  // Alice P. Albright — Millennium Challenge Corporation CEO (2022-2025)
  'EXEC-ALICE-ALBRIGHT-10-24-2022': 'MCC Chief Executive Officer',
  'EXEC-ALICE-ALBRIGHT': 'MCC Chief Executive Officer',
  'EXEC-ALICE-ALBRIGHT-2025-ERM': 'MCC Chief Executive Officer',

  // Deanne Criswell — FEMA Administrator (2021-2025)
  'EXEC-DEANNE-CRISWELL': 'FEMA Administrator',
  'EXEC-DEANNE-CRISWELL-2025-ERM': 'FEMA Administrator',
  'EXEC-DEANNE-CHRISWELL': 'FEMA Administrator', // typo'd duplicate filer id
  'EXEC-DIANNE-CRISWELL': 'FEMA Administrator', // typo'd duplicate filer id

  // Doug Burgum — Interior Secretary (2025-present)
  'EXEC-DOUGLAS-J-BURGUM': 'Interior Secretary',
  'EXEC-DOUG-BURGUM': 'Interior Secretary',

  // Sara Bailey — Director, Office of National Drug Control Policy
  // (confirmed Dec 2025)
  'EXEC-SARA-BAILEY': 'ONDCP Director',
};

/** Curated titles are display-only; never present a raw title-less string. */
export const DEFAULT_EXECUTIVE_TITLE = 'Executive Branch';

/**
 * Resolve a display title for an executive-branch filer id. Returns null for
 * non-`EXEC-*` ids (callers should not surface a title for congressional
 * filers), and {@link DEFAULT_EXECUTIVE_TITLE} for an `EXEC-*` id with no
 * curated entry.
 */
export function executiveTitleFor(filerId: string | null | undefined): string | null {
  if (!filerId) return null;
  if (!filerId.startsWith('EXEC-')) return null;
  return EXECUTIVE_TITLES[filerId] ?? DEFAULT_EXECUTIVE_TITLE;
}
