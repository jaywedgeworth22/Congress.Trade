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

import type { Extractor, ExtractorInput, ExtractorResult } from '../extractors/types.ts';
import type { Filing, Owner, ParsedTx, TxType } from '../shared/types.ts';
import { HOUSE_ASSET_TYPE_NAMES, houseAssetTypeCodePattern } from '../shared/assetTypes.ts';
import { parseAmountRange } from './amounts.ts';
import { detectOption } from './senateHtml.ts';

/** Penalty per missing core field (date / amount / type / asset). */
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

    const { text, pageCount } = await extractPdfText(input.bytes);
    const rows = parseHousePtrText(text);

    // Document confidence = mean of row confidences (or low if nothing found).
    const docConfidence =
      rows.length > 0
        ? rows.reduce((s, r) => s + r.confidence, 0) / rows.length
        : 0.3;

    // `pageCount` is a complexity signal for cascade tiering (see orchestrator.ts,
    // which persists it onto the filings row). Not part of the ExtractorResult
    // contract, so stash it on a plain object rather than widening that interface;
    // the orchestrator reads it via an optional-property cast.
    const result = {
      transactions: rows,
      confidence: docConfidence,
      raw: text,
      extractor: this.name,
      pageCount,
    };
    return result;
  }
}

// ---------------------------------------------------------------------------
// PDF text extraction
// ---------------------------------------------------------------------------

interface PdfTextExtraction {
  text: string;
  /**
   * Page count read off the parsed PDF's cheap `numPages` getter (no extra
   * parse, no page merge — pdf.js already has the document open for text
   * extraction). Null when unavailable.
   */
  pageCount: number | null;
}

async function extractPdfText(bytes: ArrayBuffer): Promise<PdfTextExtraction> {
  // unpdf accepts a Uint8Array; mergePages joins page text with newlines.
  // Copy the buffer first (bytes.slice(0)): getDocumentProxy/pdf.js transfers and
  // detaches the ArrayBuffer it is handed, so passing `bytes` directly would leave
  // the caller's buffer detached and break the HousePdfExtractor vision fallback,
  // which reuses the same ArrayBuffer after text extraction. Do not remove the copy
  // (regression guard for Sentry CONGRESS-TRADE-2).
  const pdf = await getDocumentProxy(new Uint8Array(bytes.slice(0)));
  const { text } = await extractText(pdf, { mergePages: true });
  const pageCount = typeof pdf.numPages === 'number' && Number.isFinite(pdf.numPages) ? pdf.numPages : null;
  // Cleanup the memory to prevent OOM
  if (typeof (pdf as any).destroy === 'function') (pdf as any).destroy();
  else if (typeof (pdf as any).cleanup === 'function') (pdf as any).cleanup();
  return {
    text: typeof text === 'string' ? text : (text as string[]).join('\n'),
    pageCount,
  };
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

// Asset-type bracket codes used by the House template, e.g. [ST] [OP] [GS] [4K].
const HOUSE_ASSET_TYPE_CODE_PATTERN = houseAssetTypeCodePattern();
const ASSET_TYPE_RE = new RegExp(`\\[(${HOUSE_ASSET_TYPE_CODE_PATTERN})\\]`, 'i');
// A date in MM/DD/YYYY.
const DATE_RE = /\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/g;
// An amount bracket like "$1,001 - $15,000" or "$50,000,001 +".
const AMOUNT_RE = /\$[\d,]+(?:\s*(?:-|–|—|to)\s*\$?[\d,]+|\s*\+)?/i;
// A transaction-type token (P / S / E / S (partial) ...).
const TXTYPE_RE = /\b(P|S|E)\b|\b(purchase|sale|exchange)\b/i;
const TICKER_PATTERN = String.raw`[A-Z][A-Z0-9.^\/\-]{0,9}`;
// A ticker in parentheses, e.g. "(AAPL)" or "(JPM^J)" or "(BRK/B)".
const TICKER_RE = new RegExp(String.raw`\((${TICKER_PATTERN})\)`);
const HOUSE_TABLE_HEADER_RE =
  /\b(?:Filing ID\s*#?\d+\s+)?ID\s+Owner\s+Asset\s+Transaction\s+Type\s+Date\s+Notification\s+Date\s+Amount(?:\s+Cap\.?\s*Gains(?:\s*>\s*(?:\$?\s*200\??)?)?)?/i;
const HOUSE_TABLE_HEADER_GLOBAL_RE =
  /\b(?:Filing ID\s*#?\d+\s+)?ID\s+Owner\s+Asset\s+Transaction\s+Type\s+Date\s+Notification\s+Date\s+Amount(?:\s+Cap\.?\s*Gains(?:\s*>\s*(?:\$?\s*200\??)?)?)?/gi;
const INLINE_RECORD_RE = new RegExp(
  String.raw`\b(?<owner>SP|DC|JT|SELF)\s+(?<asset>[^$]{1,220}?)\s+(?:(?:\((?<parenTicker>${TICKER_PATTERN})\))|(?:NYSE[A-Z]*:\s*(?<exchangeTicker>${TICKER_PATTERN})))?\s*\[(?<assetType>${HOUSE_ASSET_TYPE_CODE_PATTERN})\]\s+(?<txType>P|S|E|purchase|sale|exchange)(?:\s*\([^)]*\))?\s+(?<txDate>\d{1,2}\/\d{1,2}\/\d{2,4})\s+\d{1,2}\/\d{1,2}\/\d{2,4}\s+(?<amount>\$[\d,]+(?:\s*(?:-|–|—|to)\s*\$?[\d,]+|\s*\+)?)`,
  'gi',
);

/**
 * Parse the merged House PTR text into ParsedTx[]. We segment the text into
 * candidate holding blocks, then pull fields from each block.
 */
export function parseHousePtrText(text: string): ParsedTx[] {
  const cleaned = cleanPdfText(text);
  if (HOUSE_TABLE_HEADER_RE.test(cleaned)) {
    const inlineRows = parseInlineRecords(cleaned);
    if (inlineRows.length > 0) return inlineRows;
  }

  const stripped = stripHouseTableHeaders(cleaned);
  const lines = stripped
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
    .replace(new RegExp(`^.*?${HOUSE_TABLE_HEADER_RE.source}\\s*`, 'i'), '')
    .replace(HOUSE_TABLE_HEADER_GLOBAL_RE, ' ');
}

function calculateRowConfidence(row: {
  owner: Owner | null;
  assetName: string | null;
  ticker: string | null;
  txType: TxType | null;
  txDate: string | null;
  amountMin: number | null;
}): number {
  const hasOwner = Boolean(row.owner);
  const hasAsset = Boolean((row.assetName && row.assetName !== '(unknown)') || row.ticker);
  const hasTxType = Boolean(row.txType);
  const hasDate = Boolean(row.txDate && /^\d{4}-\d{2}-\d{2}$/.test(row.txDate));
  const hasAmount = row.amountMin !== null;

  if (hasOwner && hasAsset && hasTxType && hasDate && hasAmount) {
    return 1.0;
  }

  let confidence = 0.9;
  if (!hasDate) confidence -= MISSING_FIELD_PENALTY;
  if (!hasAmount) confidence -= MISSING_FIELD_PENALTY;
  if (!hasTxType) confidence -= MISSING_FIELD_PENALTY;
  if (!hasAsset) confidence -= MISSING_FIELD_PENALTY;
  return Math.max(0.3, Math.min(0.9, confidence));
}

function parseInlineRecords(text: string): ParsedTx[] {
  const normalized = stripHouseTableHeaders(text).replace(/\s+/g, ' ').trim();
  const matches: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  INLINE_RECORD_RE.lastIndex = 0;
  while ((m = INLINE_RECORD_RE.exec(normalized)) !== null) {
    matches.push(m);
  }

  const rows: ParsedTx[] = [];
  for (let i = 0; i < matches.length; i += 1) {
    m = matches[i];
    const next = matches[i + 1];
    const rawText = normalized.slice(m.index, next ? next.index : undefined).trim();
    const groups = m.groups ?? {};
    const owner = parseOwner(groups.owner ?? '');
    const ticker = normalizeTicker(groups.parenTicker ?? groups.exchangeTicker ?? null);
    const assetType = groups.assetType?.toUpperCase() ?? null;
    const details = parseHouseRowDetails(rawText);
    const assetName = cleanAssetNameString(groups.asset ?? '') || ticker || '(unknown)';
    const txType = parseTxType(groups.txType ?? '') ?? 'P';
    const txDate = toIsoDate(groups.txDate ?? '');
    const { min, max } = parseAmountRange(groups.amount ?? '');

    const confidence = calculateRowConfidence({
      owner,
      assetName,
      ticker,
      txType,
      txDate,
      amountMin: min,
    });

    rows.push({
      txDate,
      owner,
      assetName,
      ticker,
      assetType,
      assetTypeName: assetType ? HOUSE_ASSET_TYPE_NAMES[assetType] ?? null : null,
      txType,
      amountMin: min,
      amountMax: max,
      isOption: assetType === 'OP' || detectOption(rawText),
      capGainsOver200: parseCapGainsOver200(rawText),
      rawText,
      ...details,
      confidence,
    });
  }
  return rows;
}

function cleanAssetNameString(value: string): string {
  return value
    .replace(/^.*(?:\/share|shares)\s+/i, '')
    .replace(HOUSE_TABLE_HEADER_GLOBAL_RE, ' ')
    .replace(/^(?:SP|DC|JT|SELF)\b\s*/i, '')
    .replace(/\b(S|P|E|F)\s+S:\s+New\b.*$/i, '')
    .replace(/\b(S|P|E|F)\s+O:\s+.*$/i, '')
    .replace(/\bD:\s+.*$/i, '')
    .replace(/[\s\-\,]+$|^[\s\-\,]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTicker(value: string | null): string | null {
  if (!value) return null;
  const cleaned = value.trim().toUpperCase().replace(/\//g, '.');
  if (
    cleaned === 'N/A' ||
    cleaned === 'NONE' ||
    cleaned === 'N/A.' ||
    cleaned === 'NULL' ||
    /^N\s*\/\s*A$/i.test(cleaned)
  ) {
    return null;
  }
  return cleaned;
}

function blockHasAmount(lines: string[]): boolean {
  return lines.some((l) => AMOUNT_RE.test(l));
}

function blockHasDate(lines: string[]): boolean {
  return lines.some((l) => DATE_RE.test(l));
}

function startsNewHolding(line: string, completedRow: boolean): boolean {
  const ownerStart = /^(SP|DC|JT|SELF)\b/i.test(line);
  if (ownerStart) return true;
  if (completedRow) {
    const hasTicker = TICKER_RE.test(line);
    const hasAssetType = ASSET_TYPE_RE.test(line);
    if (hasTicker && hasAssetType) return true;
  }
  return false;
}

function groupBlocks(lines: string[]): string[][] {
  const cleanedLines = lines
    .map((l) => l.replace(HOUSE_TABLE_HEADER_GLOBAL_RE, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const blocks: string[][] = [];
  let current: string[] = [];

  for (const line of cleanedLines) {
    const completedRow = blockHasAmount(current) && blockHasDate(current);
    if (startsNewHolding(line, completedRow)) {
      if (current.length > 0 && blockHasAmount(current)) {
        blocks.push(current);
      }
      current = [line];
      continue;
    }
    if (current.length > 0) {
      current.push(line);
    } else {
      const hasTicker = TICKER_RE.test(line);
      const hasAssetType = ASSET_TYPE_RE.test(line);
      if (/^(SP|DC|JT|SELF)\b/i.test(line) || (hasTicker && hasAssetType)) {
        current = [line];
      }
    }
  }
  if (current.length > 0 && blockHasAmount(current)) {
    blocks.push(current);
  }
  return blocks.filter((b) => AMOUNT_RE.test(b.join(' ')));
}

function blockToParsedTx(block: string[]): ParsedTx | null {
  const joined = block.join(' ');

  const owner = parseOwner(joined);
  const ticker = parseTicker(joined);
  const assetType = parseAssetType(joined);
  const details = parseHouseRowDetails(joined);
  const assetName = parseAssetName(joined, ticker);
  const txType = parseTxType(joined);
  const dates = parseDates(joined);
  const amountText = (joined.match(AMOUNT_RE) ?? [''])[0];
  const { min, max } = parseAmountRange(amountText);
  const txDate = dates[0] ?? null;

  // Reject blocks that are clearly not a trade (no type AND no amount).
  if (!txType && min === null) return null;

  const confidence = calculateRowConfidence({
    owner,
    assetName,
    ticker,
    txType,
    txDate,
    amountMin: min,
  });

  return {
    txDate,
    owner,
    assetName: assetName || ticker || '(unknown)',
    ticker,
    assetType,
    assetTypeName: assetType ? HOUSE_ASSET_TYPE_NAMES[assetType] ?? null : null,
    txType: txType ?? 'P',
    amountMin: min,
    amountMax: max,
    isOption: detectOption(joined) || assetType === 'OP',
    capGainsOver200: parseCapGainsOver200(joined),
    rawText: joined,
    ...details,
    confidence,
  };
}

function parseHouseRowDetails(text: string): Pick<
  ParsedTx,
  'filingStatus' | 'subholding' | 'location' | 'description' | 'supplementalText'
> {
  const filingStatus = cleanDetailValue(extractDetail(text, /\bFiling\s+Status:\s*/i));
  const subholding = cleanDetailValue(extractDetail(text, /\bSubholding\s+Of:\s*/i));
  const location = cleanDetailValue(extractDetail(text, /\bLocation:\s*/i) ?? extractDetail(text, /\bL:\s*/i));
  const description = cleanDetailValue(extractDetail(text, /\bDescription:\s*/i) ?? extractDetail(text, /\bD:\s*/i));
  const supplementalText = [filingStatus, subholding, location, description].filter(Boolean).join(' | ') || null;
  return { filingStatus, subholding, location, description, supplementalText };
}

function extractDetail(text: string, label: RegExp): string | null {
  const m = label.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = text.slice(start);
  const stop = rest.search(
    /\b(?:Filing\s+Status|Subholding\s+Of|Location|Description):|\bCap\.?\s*Gains\b|\b(?:S\s+O|L|D):|\s+(?:SP|DC|JT|SELF)\b/i,
  );
  return stop >= 0 ? rest.slice(0, stop) : rest;
}

function cleanDetailValue(value: string | null): string | null {
  const cleaned = (value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\s+\b(?:P|S|E|F)\s*$/i, '')
    .trim();
  return cleaned || null;
}

function parseCapGainsOver200(text: string): boolean {
  return /\bCap\.?\s*Gains\b.{0,30}(?:checked|true|yes)|(?:☑|✓)\s*$|\bcapGainsOver200\b.{0,10}true/i.test(text);
}

function parseOwner(text: string): Owner | null {
  const m = text.match(/^(SP|DC|JT|SELF)\b/i) ?? text.match(/\b(SP|DC|JT|SELF)\b/i);
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
  return normalizeTicker(m[1]);
}

function parseAssetType(text: string): string | null {
  const m = text.match(ASSET_TYPE_RE);
  return m ? m[1].toUpperCase() : null;
}

function parseAssetName(joined: string, ticker: string | null): string {
  let name = joined.replace(/^(SP|DC|JT|SELF)\b\s*/i, '');

  const detailIndex = name.search(/\b(?:Filing Status|Subholding Of|Location|Description):|\b(?:F|S O|L|D):/i);
  if (detailIndex >= 0) {
    name = name.slice(0, detailIndex);
  }

  const assetTypeMatch = ASSET_TYPE_RE.exec(name);
  if (assetTypeMatch) {
    name = name.slice(0, assetTypeMatch.index);
  }

  const tickerMatch = TICKER_RE.exec(name);
  if (tickerMatch) {
    name = name.slice(0, tickerMatch.index);
  }

  name = name.split(/\s+(?:P|S|E)\s+\d{1,2}\/\d{1,2}\/\d{2,4}|\s+\d{1,2}\/\d{1,2}\/\d{2,4}|\s+\$[\d,]/i)[0];

  name = cleanAssetNameString(name);

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
