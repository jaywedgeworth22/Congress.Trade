/**
 * src/ingestion/houseSource.ts
 * OWNER: ingestion agent
 *
 * House Clerk financial-disclosure source.
 *
 * BULK INDEX (implemented here, the daily-cadence path):
 *   The Clerk publishes a per-year ZIP of all financial disclosures at
 *     https://disclosures-clerk.house.gov/public_disc/financial-pdfs/{YEAR}FD.ZIP
 *   The ZIP contains a single index file `{YEAR}FD.xml` listing every filing for
 *   the year (one <Member> element each). This XML is regenerated roughly DAILY,
 *   so polling the ZIP and diffing against what we've already seen is the primary
 *   change-detection mechanism. We unzip with fflate (unzipSync) entirely in
 *   memory (Workers-compatible, no node:zlib) and hand-parse the XML — the schema
 *   is flat and regular, so a dependency-free regex/scan parser is robust and
 *   avoids pulling in fast-xml-parser.
 *
 * LIVE SEARCH (intraday path — TODO hook below):
 *   The interactive UI at https://disclosures-clerk.house.gov/FinancialDisclosure
 *   is backed by a search endpoint that surfaces filings INTRADAY, before the
 *   yearly XML refreshes. For sub-day latency we will eventually poll that live
 *   search; see pollHouseLiveSearch() for the clearly-marked TODO.
 */

import { unzipSync } from 'fflate';

/** A single filing row parsed out of the House yearly index XML. */
export interface HouseFiling {
  /** Document id (the Clerk's DocID, e.g. "20012345"). */
  docId: string;
  /** Filing type code; 'P' === Periodic Transaction Report (PTR). */
  filingType: string;
  /** Disclosure year (the {YEAR} of the index, also a <Year> element). */
  year: string;
  first: string;
  last: string;
  /** State + district string, e.g. "CA01" (StateDst element). */
  stateDst: string;
  /** True when this is a PTR (filingType 'P'). */
  isPtr: boolean;
  /** Canonical pipeline doc id: `H-{year}-{DocID}`. */
  pipelineDocId: string;
  /** Direct PDF url for the PTR. */
  sourceUrl: string;
}

const HOUSE_BULK_BASE = 'https://disclosures-clerk.house.gov/public_disc/financial-pdfs';
const HOUSE_PTR_PDF_BASE = 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs';

/** Build the yearly bulk ZIP url for a given disclosure year. */
export function houseBulkZipUrl(year: number | string): string {
  return `${HOUSE_BULK_BASE}/${year}FD.ZIP`;
}

/** Build the direct PTR PDF url for a House filing. */
export function housePtrPdfUrl(year: number | string, docId: string): string {
  return `${HOUSE_PTR_PDF_BASE}/${year}/${docId}.pdf`;
}

/** Compute the canonical pipeline doc id for a House filing. */
export function houseDocId(year: number | string, docId: string): string {
  return `H-${year}-${docId}`;
}

/**
 * Decode the text content of a single XML element (handles the small set of
 * entities the Clerk emits). Trims surrounding whitespace.
 */
function decodeXmlText(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
}

/**
 * Pull the inner text of the FIRST occurrence of <tag>…</tag> within a chunk of
 * XML, or '' if absent. The House index uses simple, non-nested leaf elements.
 */
function tagText(chunk: string, tag: string): string {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i');
  const m = re.exec(chunk);
  return m ? decodeXmlText(m[1]) : '';
}

/**
 * Parse the House yearly index XML into HouseFiling[].
 *
 * The document looks like:
 *   <FinancialDisclosure>
 *     <Member>
 *       <Prefix/><Last>Smith</Last><First>Jane</First><Suffix/>
 *       <FilingType>P</FilingType><StateDst>CA01</StateDst>
 *       <Year>2024</Year><FilingDate>1/2/2024</FilingDate><DocID>20012345</DocID>
 *     </Member>
 *     …
 *   </FinancialDisclosure>
 *
 * Pure function (no network) so it is unit-testable with inline fixtures.
 * `defaultYear` is used when a <Member> omits <Year> (it normally doesn't).
 */
export function parseHouseIndexXml(xml: string, defaultYear: string): HouseFiling[] {
  const out: HouseFiling[] = [];
  const memberRe = /<Member>([\s\S]*?)<\/Member>/gi;
  let m: RegExpExecArray | null;
  while ((m = memberRe.exec(xml)) !== null) {
    const chunk = m[1];
    const docId = tagText(chunk, 'DocID');
    if (!docId) continue; // index rows without a DocID are not fetchable
    const filingType = tagText(chunk, 'FilingType');
    const year = tagText(chunk, 'Year') || defaultYear;
    const first = tagText(chunk, 'First');
    const last = tagText(chunk, 'Last');
    const stateDst = tagText(chunk, 'StateDst');
    const isPtr = filingType.toUpperCase() === 'P';
    out.push({
      docId,
      filingType,
      year,
      first,
      last,
      stateDst,
      isPtr,
      pipelineDocId: houseDocId(year, docId),
      sourceUrl: housePtrPdfUrl(year, docId),
    });
  }
  return out;
}

/**
 * Fetch the yearly ZIP, unzip it in-memory, locate `{YEAR}FD.xml`, and parse it.
 * Returns the full list of filings in the index (caller diffs against D1).
 */
export async function fetchHouseIndex(year: number | string): Promise<HouseFiling[]> {
  const url = houseBulkZipUrl(year);
  const res = await fetch(url, {
    headers: {
      // A plain UA avoids occasional WAF challenges on the Clerk host.
      'user-agent': 'congress-feed/0.1 (+https://congress.trade)',
      accept: 'application/zip,application/octet-stream,*/*',
    },
  });
  if (!res.ok) {
    throw new Error(`house bulk zip ${url} -> HTTP ${res.status}`);
  }
  const zipBytes = new Uint8Array(await res.arrayBuffer());
  const files = unzipSync(zipBytes);

  // The index file is `{YEAR}FD.xml`; fall back to the first *.xml entry.
  const wantName = `${year}FD.xml`;
  let xmlBytes: Uint8Array | undefined =
    files[wantName] ??
    files[wantName.toUpperCase()] ??
    files[wantName.toLowerCase()];
  if (!xmlBytes) {
    const xmlKey = Object.keys(files).find((k) => k.toLowerCase().endsWith('.xml'));
    if (xmlKey) xmlBytes = files[xmlKey];
  }
  if (!xmlBytes) {
    throw new Error(`house bulk zip ${url} contained no XML index (entries: ${Object.keys(files).join(',')})`);
  }
  const xml = new TextDecoder('utf-8').decode(xmlBytes);
  return parseHouseIndexXml(xml, String(year));
}

/**
 * TODO(ingestion-agent): INTRADAY live-search source.
 *
 * The yearly XML index refreshes ~once a day, so a PTR filed at 10am may not
 * appear in the ZIP until the next overnight rebuild. The live UI at
 * https://disclosures-clerk.house.gov/FinancialDisclosure is backed by a JSON
 * search endpoint (POST to the FinancialDisclosure/ViewMemberSearchResult-style
 * path with a year/last-name/filing-type body) that returns rows the same day.
 *
 * Wiring this in would let runWatcher() catch same-day House PTRs. It is left as
 * a hook because the live endpoint is undocumented/anti-bot-protected and needs
 * its own cookie/CSRF handling, so it is intentionally NOT on the hot path yet.
 * The XML diff implemented above is the correct, stable primary source for now.
 *
 * @returns the same HouseFiling[] shape so runWatcher can treat both uniformly.
 */
export async function pollHouseLiveSearch(_year: number | string): Promise<HouseFiling[]> {
  // Not implemented yet — return nothing so callers can opt in without breaking.
  return [];
}
