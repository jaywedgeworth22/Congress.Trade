/**
 * src/extraction/textPdf.ts
 * OWNER: extraction agent
 *
 * Extractor for machine-readable (text-layer) PDF disclosures (docKind 'text_pdf').
 *
 * House e-filed Periodic Transaction Reports carry a real text layer. After the
 * report header, each holding is rendered as a block such as:
 *
 *   SP  Apple Inc. (AAPL) [ST]
 *       P  06/14/2024  06/20/2024  $1,001 - $15,000
 *
 * The exact whitespace/line-wrapping varies by generator, so we extract the
 * full text via `unpdf.extractText` then reconstruct rows with tolerant
 * heuristics: an owner-code + asset line, followed by (or inline with) a
 * transaction-type code, one or two dates, and an amount bracket.
 */

import { extractText, getDocumentProxy } from 'unpdf';

import type { Extractor, ExtractorInput, ExtractorResult } from '../extractors/types';
import type { Filing, Owner, ParsedTx, TxType } from '../shared/types';
import { parseAmountRange } from './amounts';
import { detectOption } from './senateHtml';

/** Base confidence for a clean tabular text parse. */
const BASE_CONFIDENCE = 0.9;
/** Penalty per missing core field (date / amount / type). */
const MISSING_FIELD_PENALTY = 0.12;

export class TextPdfExtractor implements Extractor {
  readonly name = 'textPdf';

  canHandle(f: Filing): boolean {
    return f.docKind === 'text_pdf';
  }

  async extract(input: ExtractorInput): Promise<ExtractorResult> {
    if (!input.bytes) {
      throw new Error('textPdf: no bytes provided on ExtractorInput');
    }

    const text = await extractPdfText(input.bytes);
    const rows = parseHousePtrText(text);

    // Document confidence = mean of row confidences (or low if nothing found).
    const docConfidence =
      rows.length > 0
        ? rows.reduce((s, r) => s + r.confidence, 0) / rows.length
        : 0.3;

    return {
      transactions: rows,
      confidence: docConfidence,
      raw: text,
      extractor: this.name,
    };
  }
}

// ---------------------------------------------------------------------------
// PDF text extraction
// ---------------------------------------------------------------------------

async function extractPdfText(bytes: ArrayBuffer): Promise<string> {
  // unpdf accepts a Uint8Array; mergePages joins page text with newlines.
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: true });
  return typeof text === 'string' ? text : (text as string[]).join('\n');
}

// ---------------------------------------------------------------------------
// House PTR text parsing
// ---------------------------------------------------------------------------

const OWNER_CODES: Record<string, Owner> = {
  SP: 'spouse',
  DC: 'dependent',
  JT: 'joint',
  SELF: 'self',
};

// Asset-type bracket codes used by the House template, e.g. [ST] [OP] [GS].
const ASSET_TYPE_RE = /\[([A-Z]{2,3})\]/;
// A date in MM/DD/YYYY.
const DATE_RE = /\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/g;
// An amount bracket like "$1,001 - $15,000" or "$50,000,001 +".
const AMOUNT_RE = /\$[\d,]+(?:\s*(?:-|–|—|to)\s*\$?[\d,]+|\s*\+)?/i;
// A transaction-type token (P / S / E / S (partial) ...).
const TXTYPE_RE = /\b(P|S|E)\b|\b(purchase|sale|exchange)\b/i;
// A ticker in parentheses, e.g. "(AAPL)".
const TICKER_RE = /\(([A-Z][A-Z0-9.\-]{0,9})\)/;
const INLINE_RECORD_RE =
  /(?<asset>[A-Z0-9][^$]{1,240}?)\s+(?:(?:\((?<parenTicker>[A-Z][A-Z0-9.\/-]{0,9})\))|(?:NYSE[A-Z]*:\s*(?<exchangeTicker>[A-Z][A-Z0-9.\/-]{0,9})))?\s*\[(?<assetType>[A-Z]{2,3})\]\s+(?<txType>P|S|E|purchase|sale|exchange)(?:\s*\([^)]*\))?\s+(?<txDate>\d{1,2}\/\d{1,2}\/\d{2,4})\s+\d{1,2}\/\d{1,2}\/\d{2,4}\s+(?<amount>\$[\d,]+(?:\s*(?:-|–|—|to)\s*\$?[\d,]+|\s*\+)?)/gi;

/**
 * Parse the merged House PTR text into ParsedTx[]. We segment the text into
 * candidate holding blocks, then pull fields from each block.
 */
export function parseHousePtrText(text: string): ParsedTx[] {
  const cleaned = cleanPdfText(text);
  if (/\bID Owner Asset Transaction Type Date Notification Date Amount Cap\. Gains > \$200\?/i.test(cleaned)) {
    const inlineRows = parseInlineRecords(cleaned);
    if (inlineRows.length > 0) return inlineRows;
  }

  const lines = cleaned
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  // Group lines into blocks that each start at an owner code or a ticker line.
  const blocks = groupBlocks(lines);
  const rows: ParsedTx[] = [];
  for (const block of blocks) {
    const tx = blockToParsedTx(block);
    if (tx) rows.push(tx);
  }
  return rows;
}

function cleanPdfText(text: string): string {
  return text
    // Some House PDFs expose a text layer with NUL bytes between letters.
    // Remove them before line grouping so "S\0P" is parsed as owner code "SP".
    .replace(/\u0000/g, '')
    .replace(/\u00a0/g, ' ');
}

function stripHouseTableHeaders(text: string): string {
  return text
    .replace(/^.*?\bID Owner Asset Transaction Type Date Notification Date Amount Cap\. Gains > \$200\?\s*/i, '')
    .replace(
      /\bFiling ID\s*#?\d+\s+ID Owner Asset Transaction Type Date Notification Date Amount Cap\. Gains > \$200\?\s*/gi,
      ' ',
    );
}

function parseInlineRecords(text: string): ParsedTx[] {
  const normalized = stripInlineDetailSpans(stripHouseTableHeaders(text).replace(/\s+/g, ' ').trim());
  const rows: ParsedTx[] = [];
  let m: RegExpExecArray | null;
  INLINE_RECORD_RE.lastIndex = 0;
  while ((m = INLINE_RECORD_RE.exec(normalized)) !== null) {
    const groups = m.groups ?? {};
    const assetName = cleanInlineAssetName(groups.asset ?? '');
    const ticker = normalizeTicker(groups.parenTicker ?? groups.exchangeTicker ?? null);
    const assetType = groups.assetType?.toUpperCase() ?? null;
    const txType = parseTxType(groups.txType ?? '') ?? 'P';
    const { min, max } = parseAmountRange(groups.amount ?? '');
    rows.push({
      txDate: toIsoDate(groups.txDate ?? ''),
      owner: 'self',
      assetName: assetName || ticker || '(unknown)',
      ticker,
      assetType,
      txType,
      amountMin: min,
      amountMax: max,
      isOption: assetType === 'OP' || detectOption(m[0]),
      capGainsOver200: false,
      rawText: m[0],
      confidence: BASE_CONFIDENCE,
    });
  }
  return rows;
}

function stripInlineDetailSpans(text: string): string {
  const nextRecord =
    /\s+[A-Z][A-Za-z0-9&.,'’:/ -]{2,180}\s+(?:(?:\([A-Z][A-Z0-9.\/-]{0,9}\)\s*)|(?:NYSE[A-Z]*:\s*[A-Z][A-Z0-9.\/-]{0,9}\s*)|)\[[A-Z]{2,3}\]\s+(?:P|S|E|purchase|sale|exchange)\b/i;
  let out = '';
  let i = 0;
  while (i < text.length) {
    const detail = /\s+F\s+S:\s+New\b/i.exec(text.slice(i));
    if (!detail) {
      out += text.slice(i);
      break;
    }
    const start = i + detail.index;
    out += text.slice(i, start);
    const restStart = start + detail[0].length;
    const next = nextRecord.exec(text.slice(restStart));
    if (!next) break;
    i = restStart + next.index;
  }
  return out.replace(/\s+/g, ' ').trim();
}

function cleanInlineAssetName(value: string): string {
  return value
    .replace(/^.*(?:\/share|shares)\s+/i, '')
    .replace(/\b(F|T)\s*ID Owner Asset Transaction Type Date Notification Date Amount Cap\. Gains > \$200\?/gi, ' ')
    .replace(/\b(S|P|E|F)\s+S:\s+New\b.*$/i, '')
    .replace(/\b(S|P|E|F)\s+O:\s+.*$/i, '')
    .replace(/\bD:\s+.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTicker(value: string | null): string | null {
  if (!value) return null;
  const ticker = value.toUpperCase().replace('/', '.');
  return ticker === 'N/A' ? null : ticker;
}

function startsNewHolding(line: string): boolean {
  const ownerStart = /^(SP|DC|JT|SELF)\b/.test(line);
  const hasTicker = TICKER_RE.test(line);
  const hasAssetType = ASSET_TYPE_RE.test(line);
  return ownerStart || (hasTicker && hasAssetType);
}

function groupBlocks(lines: string[]): string[][] {
  const blocks: string[][] = [];
  let current: string[] = [];
  let seenHolding = false;
  for (const line of lines) {
    if (startsNewHolding(line)) {
      if (current.length > 0 && seenHolding) {
        blocks.push(current);
      }
      seenHolding = true;
      current = [line];
      continue;
    }
    if (!seenHolding) {
      continue;
    }
    current.push(line);
  }
  if (current.length && seenHolding) blocks.push(current);
  // Keep only blocks that look like a transaction (must have an amount).
  return blocks.filter((b) => AMOUNT_RE.test(b.join(' ')));
}

function blockToParsedTx(block: string[]): ParsedTx | null {
  const joined = block.join(' ');

  const owner = parseOwner(joined);
  const ticker = parseTicker(joined);
  const assetType = parseAssetType(joined);
  const assetName = parseAssetName(block, ticker);
  const txType = parseTxType(joined);
  const dates = parseDates(joined);
  const amountText = (joined.match(AMOUNT_RE) ?? [''])[0];
  const { min, max } = parseAmountRange(amountText);

  // Reject blocks that are clearly not a trade (no type AND no amount).
  if (!txType && min === null) return null;

  let confidence = BASE_CONFIDENCE;
  if (dates.length === 0) confidence -= MISSING_FIELD_PENALTY;
  if (min === null) confidence -= MISSING_FIELD_PENALTY;
  if (!txType) confidence -= MISSING_FIELD_PENALTY;
  if (!assetName && !ticker) confidence -= MISSING_FIELD_PENALTY;
  confidence = clamp(confidence, 0.3, BASE_CONFIDENCE);

  return {
    // Prefer the transaction date (first date) over the notification date.
    txDate: dates[0] ?? null,
    owner,
    assetName: assetName || ticker || '(unknown)',
    ticker,
    assetType,
    txType: txType ?? 'P',
    amountMin: min,
    amountMax: max,
    isOption: detectOption(joined) || assetType === 'OP',
    capGainsOver200: /(>|over|exceed).{0,8}\$?\s*200/i.test(joined),
    rawText: joined,
    confidence,
  };
}

function parseOwner(text: string): Owner | null {
  const m = text.match(/^(SP|DC|JT|SELF)\b/) ?? text.match(/\b(SP|DC|JT)\b/);
  if (m) return OWNER_CODES[m[1].toUpperCase()] ?? null;
  if (/\bspouse\b/i.test(text)) return 'spouse';
  if (/\bjoint\b/i.test(text)) return 'joint';
  if (/\b(child|dependent)\b/i.test(text)) return 'dependent';
  // House PTRs default unmarked holdings to the filer (Self).
  return 'self';
}

function parseTicker(text: string): string | null {
  const m = text.match(TICKER_RE);
  if (!m) return null;
  const t = m[1].toUpperCase();
  return t === 'N/A' ? null : t;
}

function parseAssetType(text: string): string | null {
  const m = text.match(ASSET_TYPE_RE);
  return m ? m[1].toUpperCase() : null;
}

function parseAssetName(block: string[], ticker: string | null): string {
  // The asset name is the text before the ticker / asset-type / type marker on
  // the first line of the block.
  const first = block[0] ?? '';
  let name = first
    .replace(/^(SP|DC|JT|SELF)\b\s*/, '')
    .replace(ASSET_TYPE_RE, '')
    .replace(/\([A-Z][A-Z0-9.\-]{0,9}\)/, '')
    .trim();
  // Cut off at a transaction-type / date / amount marker if they share the line.
  name = name.split(/\s+(?:P|S|E)\s+\d|\s+\d{1,2}\/\d{1,2}\/\d{2,4}|\s+\$[\d,]/)[0].trim();
  if (!name && ticker) return ticker;
  return name;
}

function parseTxType(text: string): TxType | null {
  const m = text.match(TXTYPE_RE);
  if (!m) return null;
  const tok = (m[1] || m[2] || '').toLowerCase();
  if (tok === 'p' || tok === 'purchase') return 'P';
  if (tok === 's' || tok === 'sale') return 'S';
  if (tok === 'e' || tok === 'exchange') return 'E';
  return null;
}

function parseDates(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  DATE_RE.lastIndex = 0;
  while ((m = DATE_RE.exec(text)) !== null) {
    out.push(toIsoDate(m[1]));
  }
  return out;
}

function toIsoDate(mmddyyyy: string): string {
  const m = mmddyyyy.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return mmddyyyy;
  const [, mm, dd, yy] = m;
  const year = yy.length === 2 ? `20${yy}` : yy;
  return `${year}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
