/**
 * Cheap-first extract routing + hard-stop quality gates.
 *
 * OpenRouter Files attaches a $0.50 prepaid hold to the key daily limit
 * (production is $2/day). Electronic / typed House PTRs must never take that
 * path. Files / expensive vision is only for documents classified as real
 * scans. After any cheap read, letterhead / column-header / row-limit /
 * missing-date+malformed-amount junk hard-stops before more model spend
 * (including the agreement trio).
 *
 * Cost target for a typed House PTR: local unpdf + optional Flash-Lite text
 * call (tokens only, typically well under $0.01) — not a $0.50 Files hold.
 */

import type { Filing, ParsedTx } from '../shared/types.ts';

/** Same publish cap the normalizer uses; duplicated to avoid an import cycle. */
export const EXTRACT_ROW_LIMIT = 200;

export type HouseExtractKind = 'electronic' | 'scanned' | 'unknown';

export interface HouseExtractRoute {
  kind: HouseExtractKind;
  /** True only when OpenRouter Files / expensive vision is allowed. */
  allowFiles: boolean;
}

export interface ExtractQuality {
  ok: boolean;
  /** Stable reason token when ok is false. */
  reason?: string;
}

const HOUSE_DOC_ID_RE = /^H-(\d{4})-(\d+)$/i;

/**
 * House electronic FD system DocIDs are 8-digit values in the 20xxxxxx range
 * (live review corpus: H-2025-200xxxxx). Paper/scan batches use 7-digit
 * 822xxxx / 911xxxx series.
 */
export function housePtrNumericId(docId: string): string | null {
  const match = HOUSE_DOC_ID_RE.exec(docId.trim());
  return match?.[2] ?? null;
}

export function isHouseElectronicDocId(docId: string): boolean {
  const numeric = housePtrNumericId(docId);
  return numeric != null && numeric.length >= 8 && numeric.startsWith('20');
}

export function isHousePaperScanDocId(docId: string): boolean {
  const numeric = housePtrNumericId(docId);
  return numeric != null && /^(822|911)/.test(numeric);
}

export function filingDocClass(filing: Filing): string | null {
  const extra = filing as Filing & { docClass?: string | null };
  const value = extra.docClass;
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

/**
 * Decide whether this House filing may use OpenRouter Files / paid vision.
 * Electronic DocIDs, typed/text_pdf, and empty/corrupt classes never do.
 */
export function classifyHouseExtractRoute(filing: Filing): HouseExtractRoute {
  const docClass = filingDocClass(filing);
  const docKind = (filing.docKind || '').trim().toLowerCase();

  if (isHouseElectronicDocId(filing.docId) || docKind === 'text_pdf' || docClass === 'typed') {
    return { kind: 'electronic', allowFiles: false };
  }
  if (docKind === 'senate_html' || docClass === 'empty' || docClass === 'corrupt') {
    return { kind: 'electronic', allowFiles: false };
  }
  if (isHousePaperScanDocId(filing.docId) || docClass === 'clean_scan' || docClass === 'hard_scan') {
    return { kind: 'scanned', allowFiles: true };
  }
  if (docKind === 'scanned_pdf') {
    return { kind: 'scanned', allowFiles: true };
  }
  return { kind: 'unknown', allowFiles: false };
}

export function allowOpenRouterFiles(filing: Filing): boolean {
  return classifyHouseExtractRoute(filing).allowFiles;
}

/**
 * True when extracted PDF/HTML text looks like a real trade table, not
 * letterhead. Used to decide whether a cheap text-model call is worth it.
 */
export function looksLikePlausibleTradeTable(text: string): boolean {
  const body = (text || '').trim();
  if (body.length < 40) return false;
  if (looksLikeHeaderContaminatedAsset(body.slice(0, 240))) {
    // Letterhead in the first lines is normal on a PTR; still require trade tokens.
  }
  const dates = body.match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g)?.length ?? 0;
  const amounts = body.match(/\$[\d,]+/g)?.length ?? 0;
  const owners = body.match(/\b(?:SP|DC|JT|SELF)\b/g)?.length ?? 0;
  const tickers = body.match(/\([A-Z][A-Z0-9.^\/\-]{0,9}\)/g)?.length ?? 0;
  const txCodes = body.match(/\b(?:P|S|E)\b|\bpurchase\b|\bsale\b/gi)?.length ?? 0;
  return (dates >= 1 && amounts >= 1 && (owners >= 1 || tickers >= 1 || txCodes >= 1));
}

/**
 * True when the "asset name" is PTR form chrome (letterhead / column headers),
 * not a tradeable security.
 */
export function looksLikeHeaderContaminatedAsset(assetName: string | null): boolean {
  if (!assetName) return false;
  return /(?:\bClerk of the House of Representatives\b|\bLegislative Resource Center\b|\bB-?81 Cannon Building\b|\bCannon Building\b|\bID Owner Asset Transaction Type\b|\bTransaction Type Date Notification Date Amount\b|\bPeriodic Transaction Report\b|Name:\s*Hon\.|Status:\s*Member|State\/District:|\bMember of the U\.?S\.?\s+House\b|\bOfficer or Employee\b|\bOffice Telephone\b|\bEmploying Off(?:ice)?\b|\bunreadable asset\b|HOUSE OF\s+REP|\bCfficar\b|\bDiotict\b|Use oSucem|I certify that|Signature of Reporting)/i.test(
    assetName,
  );
}

export function looksLikeColumnHeaderAsset(assetName: string | null): boolean {
  if (!assetName) return false;
  const trimmed = assetName.trim();
  if (!trimmed) return false;
  return /^(?:id|owner|asset(?:\s+name)?|ticker|transaction\s+type|type|date|notification(?:\s+date)?|amount(?:\s+range)?|cap(?:ital)?\s+gains)$/i.test(
    trimmed,
  ) || /^(?:ID\s+Owner|Asset\s+Transaction|Notification Date|Amount of Transaction)$/i.test(trimmed);
}

function isMalformedAmount(tx: ParsedTx): boolean {
  return tx.amountMin == null && tx.amountMax == null;
}

/**
 * Hard-stop before more model spend. Empty extracts are not junk — they are
 * just empty. Letterhead-as-asset, column headers, row-limit floods, and
 * majority missing-date + malformed-amount reads are junk.
 */
export function evaluateExtractQuality(transactions: readonly ParsedTx[]): ExtractQuality {
  const rows = transactions ?? [];
  if (rows.length === 0) return { ok: true };

  const letterhead = rows.filter((tx) => looksLikeHeaderContaminatedAsset(tx.assetName));
  if (letterhead.length > 0 && letterhead.length >= Math.max(1, rows.length * 0.4)) {
    return { ok: false, reason: 'letterhead_as_asset' };
  }

  const headers = rows.filter((tx) => looksLikeColumnHeaderAsset(tx.assetName));
  if (headers.length > 0 && headers.length >= Math.max(1, rows.length * 0.4)) {
    return { ok: false, reason: 'column_header_as_asset' };
  }

  if (rows.length > EXTRACT_ROW_LIMIT) {
    return { ok: false, reason: 'extraction_row_limit' };
  }

  const broken = rows.filter((tx) => !tx.txDate && isMalformedAmount(tx));
  if (rows.length >= 3 && broken.length / rows.length >= 0.6) {
    return { ok: false, reason: 'missing_tx_date_malformed_amount' };
  }

  const meanConf = rows.reduce((sum, tx) => sum + (Number.isFinite(tx.confidence) ? tx.confidence : 0), 0)
    / rows.length;
  if (
    meanConf > 0
    && meanConf <= 0.25
    && (letterhead.length > 0 || broken.length >= Math.ceil(rows.length * 0.5))
  ) {
    return { ok: false, reason: 'low_confidence_junk' };
  }

  return { ok: true };
}

const AGREEMENT_HARD_STOP_RE =
  /form_chrome|letterhead_as_asset|column_header_as_asset|ocr_unusable|extraction_row_limit|missing_tx_date_malformed_amount|low_confidence_junk|letterhead/i;

/** Review-queue reasons that must never spend the agreement trio. */
export function shouldSkipAgreementForReviewReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return AGREEMENT_HARD_STOP_RE.test(reason);
}

export function shouldEnqueueAgreement(input: {
  filing: Filing;
  extractor?: string | null;
  quality: ExtractQuality;
  reviewReason?: string | null;
}): boolean {
  if (!input.quality.ok) return false;
  if (shouldSkipAgreementForReviewReason(input.reviewReason)) return false;
  const route = classifyHouseExtractRoute(input.filing);
  if (route.kind === 'electronic' || !route.allowFiles) return false;
  return true;
}

/** Estimated Files prepaid hold in USD (OpenRouter key-limit, not wallet). */
export const OPENROUTER_FILES_HOLD_USD = 0.5;

/**
 * Typed PTR cost envelope used in tests / PR receipts. Local unpdf is $0;
 * a Flash-Lite text completion is tokens only.
 */
export const TYPED_PTR_CHEAP_PATH_USD_CEILING = 0.02;
