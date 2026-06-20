/**
 * src/ingestion/classifier.ts
 * OWNER: ingestion agent
 *
 * Handles {type:'filing.fetched'}: inspects the raw R2 object and determines
 * docKind (senate_html | text_pdf | scanned_pdf | unknown), persists
 * filings.doc_kind + ingest_status='classified', then enqueues the message that
 * triggers extraction.
 *
 * Per the QueueMessage contract in src/index.ts, the post-classification
 * hand-off message consumed by the extraction stage is {type:'filing.extracted'}
 * (index.ts routes 'filing.fetched' -> classifyFiling and leaves 'filing.extracted'
 * as the downstream extraction hook). We emit that.
 *
 * DETECTION HEURISTIC (cheap, no PDF parsing lib):
 *   - Senate electronic report  -> body is HTML (content-type text/html OR the
 *     bytes start with an HTML marker / contain an eFD report table) => 'senate_html'.
 *   - PDF (starts with "%PDF")  -> sample the decompressed-agnostic raw bytes for
 *     text-layer markers (a "/Font" resource and/or BT…Tj text-show operators):
 *       * markers present  => 'text_pdf'   (extractable text layer)
 *       * ~no text markers  => 'scanned_pdf' (image-only scan; needs vision OCR)
 *   - Anything else => 'unknown'.
 *
 * The PDF text-layer check is a HEURISTIC: we scan a bounded prefix (first ~256KB)
 * of the raw bytes for `/Font`, `BT`/`ET`, and `Tj`/`TJ` operators. Text layers
 * almost always declare a /Font and emit text-show operators in the content
 * stream; pure scans embed a single /Image XObject with no fonts. This avoids a
 * full PDF parse while being robust enough to route to the correct extractor; the
 * vision extractor is the safe fallback for ambiguous PDFs.
 */

import type { Env, DocKind } from '../shared/types';
import { get, run } from '../shared/db';

interface FilingRow {
  doc_id: string;
  chamber: string | null;
  source_url: string | null;
  raw_object_key: string | null;
}

const PDF_SNIFF_BYTES = 256 * 1024; // bound the scan to the first 256KB

/** True if the leading bytes look like a PDF ("%PDF-"). */
export function looksLikePdf(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 5 &&
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 && // F
    bytes[4] === 0x2d // -
  );
}

/** True if the content/markup looks like HTML. */
export function looksLikeHtml(contentType: string, text: string): boolean {
  if (/text\/html|application\/xhtml/i.test(contentType)) return true;
  const head = text.slice(0, 2048).toLowerCase();
  return (
    head.includes('<!doctype html') ||
    head.includes('<html') ||
    head.includes('<head') ||
    // eFD report pages embed a recognizable table container.
    head.includes('table report-data') ||
    head.includes('id="filedreports"')
  );
}

/**
 * Heuristic text-layer detection over a (bounded) PDF byte sample.
 * Returns 'text_pdf' when font + text-show markers are present, else 'scanned_pdf'.
 */
export function classifyPdfBytes(bytes: Uint8Array): 'text_pdf' | 'scanned_pdf' {
  const sample = bytes.subarray(0, Math.min(bytes.length, PDF_SNIFF_BYTES));
  // Latin1 decode keeps PDF operator bytes intact (binary-safe for ASCII tokens).
  const text = new TextDecoder('latin1').decode(sample);
  const hasFont = text.includes('/Font');
  const hasTextShow = /\bBT\b[\s\S]*?\b(Tj|TJ)\b/.test(text) || /\)\s*Tj/.test(text);
  // A scan typically has an /Image XObject and no fonts.
  const hasImageOnly = /\/Subtype\s*\/Image/.test(text) && !hasFont;
  if (hasFont && hasTextShow) return 'text_pdf';
  if (hasImageOnly) return 'scanned_pdf';
  // Fallback: if any text-show markers exist, treat as text; else scanned.
  return hasTextShow ? 'text_pdf' : 'scanned_pdf';
}

/**
 * Decide the DocKind for already-fetched raw bytes + content-type, without DB.
 * Pure function for unit-testing.
 */
export function decideDocKind(
  bytes: Uint8Array,
  contentType: string,
  chamber: string | null,
): DocKind {
  if (looksLikePdf(bytes)) {
    return classifyPdfBytes(bytes);
  }
  // Decode a prefix as UTF-8 for HTML sniffing.
  const text = new TextDecoder('utf-8').decode(
    bytes.subarray(0, Math.min(bytes.length, 8192)),
  );
  if (looksLikeHtml(contentType, text)) {
    // HTML from the Senate eFD is the electronic-report case.
    return 'senate_html';
  }
  // Senate paper filings sometimes arrive as a PDF without a %PDF prefix detected
  // above; if the chamber is senate and it's clearly not HTML, leave 'unknown'
  // so the pipeline can route it to review rather than mis-extract.
  return 'unknown';
}

/**
 * Classify a fetched filing's raw object into a DocKind, persist it, and
 * enqueue the extraction hand-off message.
 */
export async function classifyFiling(env: Env, docId: string): Promise<DocKind> {
  const row = await get<FilingRow>(
    env.DB,
    `SELECT doc_id, chamber, source_url, raw_object_key FROM filings WHERE doc_id = ?`,
    [docId],
  );
  if (!row) {
    console.warn(`classifier: no filings row for ${docId}; skipping`);
    return 'unknown';
  }
  const key = row.raw_object_key;
  if (!key) {
    await run(
      env.DB,
      `UPDATE filings SET ingest_status = 'error', error = ? WHERE doc_id = ?`,
      ['classifier: missing raw_object_key', docId],
    );
    return 'unknown';
  }

  const obj = await env.RAW_FILES.get(key);
  if (!obj) {
    await run(
      env.DB,
      `UPDATE filings SET ingest_status = 'error', error = ? WHERE doc_id = ?`,
      [`classifier: R2 object ${key} not found`, docId],
    );
    return 'unknown';
  }

  const contentType = obj.httpMetadata?.contentType ?? '';
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const docKind = decideDocKind(bytes, contentType, row.chamber);

  await run(
    env.DB,
    `UPDATE filings
        SET doc_kind = ?, ingest_status = 'classified', error = NULL
      WHERE doc_id = ?`,
    [docKind, docId],
  );

  // Hand off to the extraction stage. Per the QueueMessage contract this is the
  // message the extraction step consumes (see src/index.ts routing).
  await env.INGEST_QUEUE.send({ type: 'filing.extracted', docId });

  return docKind;
}
