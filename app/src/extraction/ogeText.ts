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
 * pdf.js merges each row onto one line of text, e.g.:
 *
 *   1 Amazon.com, Inc. (AMZN) Sale 06/10/2022 No $1,001 - $15,000
 *
 * This is a DIFFERENT layout from the House PTR text_pdf format that
 * textPdf.ts targets (House rows carry an owner code + a bracketed asset-type
 * code across two source lines; OGE 278-T rows have neither and are single-
 * line). Routing an executive filing through the House-tuned parser silently
 * yields zero rows — this extractor claims chamber==='executive' text_pdf
 * filings ahead of the generic TextPdfExtractor in buildExtractorPipeline()
 * so those filings get a parser that actually matches their layout.
 *
 * SCOPE: the dedicated 278-T "Periodic Transaction Report" form only. The
 * broader OGE 278e annual/termination disclosure (a much larger multi-section
 * form whose own Part 7 "Transactions" table uses a harder-to-bound layout
 * interleaved with unrelated numbered lists — positions held, agreements,
 * assets) is intentionally NOT targeted: ROW_RE requires the full
 * type+date+notification+amount suffix on one line, so 278e prose simply
 * fails to match and yields zero rows (safe no-op), never a wrong parse.
 * A scanned/OCR'd 278-T whose text layer is garbled (e.g. "Fobn.iary" for
 * "February") also correctly yields zero rows rather than guessed data.
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

// One flat transaction row:
//   "<#> <description...> <Purchase|Sale|Exchange> <MM/DD/YYYY> <Yes|No> <$amount[-$amount]>"
// The suffix (type + date + Yes/No + amount) is anchored to end-of-line, so a
// non-greedy description can never stop early on a false-positive "sale"
// inside a company name — the whole remainder still has to match.
const ROW_RE =
  /^\s*\d{1,3}\s+(.+?)\s+(Purchase|Sale|Exchange)\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(?:Yes|No)\s+(\$[\d,]+(?:\.\d+)?(?:\s*(?:-|–|—|to)\s*\$?[\d,]+(?:\.\d+)?|\s*\+)?)\s*$/i;

const TX_TYPE_MAP: Record<string, TxType> = {
  purchase: 'B',
  sale: 'S',
  exchange: 'E',
};

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
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const rows: ParsedTx[] = [];
  for (const line of lines) {
    const m = ROW_RE.exec(line);
    if (!m) continue;
    const [, descriptionRaw, typeWord, dateRaw, amountRaw] = m;
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
      isOption: detectOption(line),
      capGainsOver200: false,
      rawText: line,
      confidence,
    });
  }
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
