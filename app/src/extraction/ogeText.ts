/**
 * src/extraction/ogeText.ts
 * OWNER: extraction agent
 *
 * Extractor for the dedicated OGE Form 278-T "Periodic Transaction Report"
 * PDF filed by executive-branch personnel (docKind 'text_pdf', chamber
 * 'executive'). Purely deterministic text-layer parsing — no network calls,
 * no model calls.
 *
 * The 278-T renders its transactions as a single flat table with columns:
 *   # | DESCRIPTION | TYPE | DATE | NOTIFICATION RECEIVED OVER 30 DAYS AGO | AMOUNT
 * e.g. one logical row reads:
 *
 *   1 Amazon.com, Inc. (AMZN) Sale 06/10/2022 No $1,001 - $15,000
 *
 * IMPORTANT: unpdf's mergePages text-layout heuristic (pdf.js's line-break
 * insertion, driven by Y-coordinate deltas between text items) is NOT
 * guaranteed to insert a newline between rows — verified in production
 * (Cloudflare Workers runtime) that an entire multi-page 278-T comes back as
 * ONE line with no `\n` at all, while the same PDF parsed locally under
 * Node.js does insert per-row newlines. Parsing therefore does NOT split on
 * `\n` and match per line (that silently found 0 rows in production while
 * finding 3/3 in local Node testing — a real incident, not a hypothetical).
 * Instead the whole merged text is whitespace-normalized to single spaces
 * (folding away import '\n'/'\r' too) and scanned with a GLOBAL regex, the
 * same technique textPdf.ts's parseInlineRecords() uses for the same reason.
 * `\s+` matches a real newline just as well as a run of spaces, so this
 * approach is correct under EITHER text-layout behavior.
 *
 * This is a DIFFERENT layout from the House PTR text_pdf format that
 * textPdf.ts targets (House rows carry an owner code + a bracketed asset-type
 * code; OGE 278-T rows have neither). Routing an executive filing through the
 * House-tuned parser silently yields zero rows — OgePdfExtractor claims
 * chamber==='executive' text_pdf and scanned_pdf filings ahead of the generic
 * TextPdfExtractor in buildExtractorPipeline() and runs this parser first.
 * True scans that yield zero rows then take a fail-soft OpenRouter vision
 * path; this class itself still only claims text_pdf.
 *
 * SCOPE: the dedicated 278-T "Periodic Transaction Report" form only. The
 * broader OGE 278e annual/termination disclosure (a much larger multi-section
 * form whose own Part 7 "Transactions" table uses a harder-to-bound layout
 * interleaved with unrelated numbered lists — positions held, agreements,
 * assets) is intentionally NOT targeted: ROW_RE requires the full
 * type+date+notification+amount suffix to immediately follow the description,
 * so 278e prose simply fails to match and yields zero rows (safe no-op),
 * never a wrong parse. A scanned/OCR'd 278-T whose text layer is garbled
 * (e.g. "Fobn.iary" for "February") also correctly yields zero rows rather
 * than guessed data.
 */

import { extractText, getDocumentProxy } from 'unpdf';

import type { Extractor, ExtractorInput, ExtractorResult } from '../extractors/types.ts';
import type { Filing, ParsedTx, TxType } from '../shared/types.ts';
import { parseAmountRange } from './amounts.ts';
import { detectOption } from './senateHtml.ts';

/** Penalty applied when a matched row is missing a core field. */
const INCOMPLETE_ROW_CONFIDENCE = 0.6;
/** Confidence for a fully-populated row (mirrors textPdf.ts's House-form
 *  "owner is implicit" treatment: the 278-T has no per-row owner column). */
const COMPLETE_ROW_CONFIDENCE = 0.97;

const TICKER_PATTERN = String.raw`[A-Z][A-Z0-9.^\/\-]{0,9}`;
const TICKER_SUFFIX_RE = new RegExp(String.raw`\((${TICKER_PATTERN})\)\s*$`);

// The table header always appears immediately before the first transaction
// row (verified against real production text). Anchoring the scan to start
// AFTER it is the primary defense against false-positive row-number matches
// in the surrounding boilerplate (legal prose is full of "<digit> <word>"
// sequences — e.g. "5 U.S.C. app. section 101 et seq." — that would
// otherwise be indistinguishable from a real row's leading "# ").
const TABLE_HEADER_RE = /#\s*[\.,:;]?\s*DESCRIPTION\s+TYPE\s+DATE\s+NOTIFICATION\s+RECEIVED\s+OVER\s+30\s+DAYS\s+AGO\s+AMOUNT/i;

// The row number is up to FIVE digits: a large executive 278-T (Trump's runs past
// row 3600) numbers its rows into the thousands, and the old `\d{1,3}` could not
// anchor them at all (board row 3d31c7b9).
// One flat transaction row, scanned globally over the (whitespace-normalized,
// header-anchored) document text rather than split by line — see the module
// comment for why "split by line" doesn't work here. The leading
// `(?<![\d,.])` stops the row-number token from matching inside a dollar
// amount (e.g. the "001" in "$1,001"): such a match is always preceded by a
// digit or comma, which this excludes. The description is capped at 200
// chars (`.{1,200}?`, still non-greedy) rather than unbounded `.+?` as a
// second layer of defense — a genuine 278-T description is a short "Company
// Name (TICK)" string, so an accidental match that ran past the header
// anchor (e.g. scanning without TABLE_HEADER_RE found) fails fast instead of
// swallowing hundreds of characters of prose to reach a later real row.
const ROW_RE =
  /(?<![\d,.])\d{1,5}[\.,:;]?\s+(.{1,200}?)\s+(Purchase|Sale|Exchange)\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(?:Yes|No)\s+(\$[\d,]+(?:\.\d+)?(?:\s*(?:-|–|—|to)\s*\$?[\d,]+(?:\.\d+)?|\s*\+)?)/gi;

const TX_TYPE_MAP: Record<string, TxType> = {
  purchase: 'B',
  sale: 'S',
  exchange: 'E',
};

/**
 * Coherence floor for the matched rows' leading "#" tokens.
 *
 * On a clean text layer, ROW_RE's row anchor is the table's own sequential,
 * unique "#" column (1, 2, 3, …). On a scanned-then-OCR'd 278-T the type word
 * is garbled on most rows ("salo", "lourchaso", "ourchase"), so ROW_RE only
 * matches the minority of rows whose type survived — and its leading `\d{1,5}`
 * then latches onto whatever bare number precedes that surviving word: bond
 * maturity years ("2028"), dollar fragments ("15000"), page numbers. The
 * resulting sequence jumps around and repeats heavily. Those rows are
 * mis-merged guesses (a description swallowed from the previous physical row),
 * not transactions. Producing zero rows instead parks the filing for an honest
 * human/vision read rather than publishing wrong data — the same "blocked, not
 * a wrong parse" contract this module already documents for garbled OCR.
 */
const MIN_ROWS_FOR_SEQUENCE_CHECK = 8;
const MIN_DISTINCT_INDEX_RATIO = 0.7;
const MAX_NON_INCREASING_STEP_RATIO = 0.3;

/**
 * True when the matched rows' leading "#" tokens look like a real table index:
 * essentially unique and strictly increasing (allowing a few OCR skips/dupes).
 * Filings with fewer than eight rows are always treated as coherent.
 */
export function isOgeRowSequenceCoherent(indexes: readonly number[]): boolean {
  const n = indexes.length;
  if (n < MIN_ROWS_FOR_SEQUENCE_CHECK) return true;
  if (new Set(indexes).size / n < MIN_DISTINCT_INDEX_RATIO) return false;
  let nonIncreasing = 0;
  for (let i = 1; i < n; i += 1) {
    if (indexes[i] <= indexes[i - 1]) nonIncreasing += 1;
  }
  return nonIncreasing / (n - 1) <= MAX_NON_INCREASING_STEP_RATIO;
}

export class OgeTextExtractor implements Extractor {
  readonly name = 'ogeText';

  /** Claims executive-branch text_pdf filings ahead of the House-tuned parser. */
  canHandle(f: Filing): boolean {
    return f.chamber === 'executive' && f.docKind === 'text_pdf';
  }

  async extract(input: ExtractorInput): Promise<ExtractorResult> {
    if (!input.bytes) {
      throw new Error('ogeText: no bytes provided on ExtractorInput');
    }
    const { text, pageCount } = await extractPdfText(input.bytes);
    const rows = parseOgeTransactionRows(text);
    const confidence =
      rows.length > 0 ? rows.reduce((s, r) => s + r.confidence, 0) / rows.length : 0.3;
    const result = {
      transactions: rows,
      confidence,
      raw: text,
      extractor: this.name,
      pageCount,
    };
    return result;
  }
}

async function extractPdfText(
  bytes: ArrayBuffer,
): Promise<{ text: string; pageCount: number | null }> {
  // Copy the buffer first: getDocumentProxy/pdf.js transfers and detaches the
  // ArrayBuffer it is handed (same regression guard as textPdf.ts's
  // extractPdfText — see its comment referencing Sentry CONGRESS-TRADE-2).
  const pdf = await getDocumentProxy(new Uint8Array(bytes.slice(0)));
  const { text } = await extractText(pdf, { mergePages: true });
  const pageCount =
    typeof pdf.numPages === 'number' && Number.isFinite(pdf.numPages) ? pdf.numPages : null;
  if (typeof (pdf as any).destroy === 'function') (pdf as any).destroy();
  else if (typeof (pdf as any).cleanup === 'function') (pdf as any).cleanup();
  return {
    text: typeof text === 'string' ? text : (text as string[]).join('\n'),
    pageCount,
  };
}

/** Parse the merged 278-T text into ParsedTx[]. Pure / unit-testable. */
export function parseOgeTransactionRows(text: string): ParsedTx[] {
  // Fold NUL bytes, non-breaking spaces, and every run of whitespace
  // (including real newlines, when the runtime's pdf.js DOES emit them) down
  // to single spaces, so the same global scan below is correct regardless of
  // whether rows arrived newline-separated or all on one line.
  const normalized = text
    .replace(/\u0000/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return [];

  // Prefer scanning only after the table header (see TABLE_HEADER_RE above);
  // fall back to the whole text if the header wasn't found (a format variant
  // this module hasn't seen), relying on ROW_RE's own length cap + required
  // suffix as the safety net in that case.
  const headerMatch = TABLE_HEADER_RE.exec(normalized);
  const searchText = headerMatch
    ? normalized.slice(headerMatch.index + headerMatch[0].length)
    : normalized;

  const rows: ParsedTx[] = [];
  const rowIndexes: number[] = [];
  ROW_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ROW_RE.exec(searchText)) !== null) {
    const [matchText, descriptionRaw, typeWord, dateRaw, amountRaw] = m;
    const indexMatch = /^(\d{1,5})/.exec(matchText);
    if (indexMatch) rowIndexes.push(Number(indexMatch[1]));
    const description = descriptionRaw.trim();
    const tickerMatch = TICKER_SUFFIX_RE.exec(description);
    const ticker = tickerMatch ? normalizeTicker(tickerMatch[1]) : null;
    const assetName = (ticker ? description.replace(TICKER_SUFFIX_RE, '') : description).trim() || '(unknown)';
    const txType = TX_TYPE_MAP[typeWord.toLowerCase()] ?? 'B';
    const txDate = toIsoDate(dateRaw);
    const { min, max } = parseAmountRange(amountRaw);
    const hasDate = /^\d{4}-\d{2}-\d{2}$/.test(txDate);
    const hasAmount = min !== null;
    // ROW_RE requires description+type+date+amount to all be present for any
    // match, so every row here already has the four core fields; the only
    // thing that can still be "incomplete" is a date/amount that matched the
    // regex shape but failed to parse cleanly (e.g. an out-of-range date).
    const confidence = hasDate && hasAmount ? COMPLETE_ROW_CONFIDENCE : INCOMPLETE_ROW_CONFIDENCE;

    rows.push({
      txDate: hasDate ? txDate : null,
      owner: null, // 278-T has no per-row owner column (unlike House SP/DC/JT codes)
      assetName,
      ticker,
      assetType: null,
      assetTypeName: null,
      txType,
      amountMin: min,
      amountMax: max,
      isOption: detectOption(matchText),
      capGainsOver200: false,
      rawText: matchText.trim(),
      confidence,
    });
    // Avoid an infinite loop on a zero-length match (shouldn't happen given
    // ROW_RE always consumes at least the row-number + suffix, but a global
    // regex with a zero-width overall match would otherwise stall exec()).
    if (m.index === ROW_RE.lastIndex) ROW_RE.lastIndex += 1;
  }
  // Refuse a garbled-OCR parse: if the matched "#" tokens are not a plausible
  // unique/increasing table index, ROW_RE was latching onto years/amounts and
  // the rows are mis-merged guesses. Zero rows is the safe outcome.
  if (!isOgeRowSequenceCoherent(rowIndexes)) return [];
  return rows;
}

function normalizeTicker(value: string | null): string | null {
  if (!value) return null;
  const cleaned = value.trim().toUpperCase().replace(/\//g, '.');
  if (cleaned === 'N/A' || cleaned === 'NONE' || cleaned === 'NULL') return null;
  return cleaned;
}

function toIsoDate(mmddyyyy: string): string {
  const m = mmddyyyy.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return mmddyyyy;
  const [, mm, dd, yy] = m;
  const year = yy.length === 2 ? `20${yy}` : yy;
  return `${year}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}
