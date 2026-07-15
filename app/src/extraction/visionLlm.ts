/**
 * src/extraction/visionLlm.ts
 * OWNER: extraction agent
 *
 * Vision/LLM extractor for scanned-image PDFs (docKind 'scanned_pdf').
 *
 * Many House PTRs are scanned, hand-annotated paper forms with no text layer.
 * We send the raw PDF bytes (Gemini accepts application/pdf inline) to Google
 * Gemini's generateContent endpoint with a strict JSON responseSchema and parse
 * the structured array of transactions back into ParsedTx[].
 *
 * Design goals:
 *   - ONE network call per document (keep token use low).
 *   - Deterministic, schema-constrained output (responseMimeType JSON).
 *   - Conservative confidence so most scanned docs route to human review.
 *   - On any API/parse failure: throw, so the pipeline marks the filing errored.
 */

import type { Extractor, ExtractorInput, ExtractorResult } from '../extractors/types';
import type { Env, Filing, Owner, ParsedTx, TxType } from '../shared/types';
import { parseAmountRange } from './amounts';
import { PDFDocument } from 'pdf-lib';
import { resolveSecret } from '../secrets/infisical';
import { trackedFetch } from '../shared/thirdPartyTelemetry';
import { GoogleGenAI } from '@google/genai';

/**
 * Gemini model id. Centralized + documented so it is trivial to bump.
 * NOTE: Flash model ids rotate; if calls start 404-ing, update this to the
 * current Flash generation — the request/response contract below is unchanged
 * across Flash generations. Current as of 2026-06: 'gemini-3.5-flash'.
 * Override via env var VISION_PRIMARY_MODEL.
 */
const DEFAULT_MODEL = 'gemini-3.5-flash';



/** Default confidence floor for vision output (most route to review). */
const DEFAULT_CONFIDENCE = 0.6;

/** Optional overrides for building a second, independent vision extractor. */
export interface VisionLlmOptions {
  /** API key to use instead of env.GEMINI_API_KEY (e.g. ARBITRATION_API_KEY). */
  apiKey?: string;
  /** Runtime secret name to resolve when apiKey is not supplied. */
  apiKeyName?: keyof Env & string;
  /** Model id to use instead of the default (a different model = real cross-check). */
  model?: string;
  /** Config name resolved at extraction time when `model` is not supplied
   *  (Infisical first, env fallback) — so model choice is live-tunable. */
  modelEnvName?: keyof Env & string;
  /** Fallback model when neither `model` nor the resolved config name is set. */
  defaultModel?: string;
  /** Override extractor name (so arbitration can tell the two apart). */
  name?: string;
}

export class VisionLlmExtractor implements Extractor {
  readonly name: string;
  private readonly modelOverride?: string;
  private readonly modelEnvName: keyof Env & string;
  private readonly defaultModel: string;
  private readonly apiKeyOverride?: string;
  private readonly apiKeyName: keyof Env & string;

  constructor(
    private readonly env: Env,
    options: VisionLlmOptions = {},
  ) {
    this.name = options.name ?? 'visionLlm';
    this.modelOverride = options.model;
    this.modelEnvName = options.modelEnvName ?? 'VISION_PRIMARY_MODEL';
    this.defaultModel = options.defaultModel ?? DEFAULT_MODEL;
    this.apiKeyOverride = options.apiKey;
    this.apiKeyName = options.apiKeyName ?? 'GEMINI_API_KEY';
  }

  canHandle(f: Filing): boolean {
    return f.docKind === 'scanned_pdf';
  }

  /** Explicit override > Infisical/env config name > default. Resolved per
   *  extraction so a model swap in Infisical applies without a redeploy. */
  private async resolveModel(): Promise<string> {
    if (this.modelOverride) return this.modelOverride;
    try {
      return (await resolveSecret(this.env, this.modelEnvName)).value || this.defaultModel;
    } catch {
      return (this.env[this.modelEnvName] as string | undefined) || this.defaultModel;
    }
  }

    async extract(input: ExtractorInput): Promise<ExtractorResult> {
    let key = this.apiKeyOverride ?? (await resolveSecret(this.env, this.apiKeyName)).value;
    if (!key && this.apiKeyName === 'GEMINI_API_KEY') {
      key = (await resolveSecret(this.env, 'CT_GEMINI_API_KEY')).value;
    }
    if (!key) throw new Error(`${this.name}: API key is not configured`);
    if (!input.bytes) throw new Error(`${this.name}: no bytes provided on ExtractorInput`);

    const model = await this.resolveModel();

    // Check if we need to chunk (only for scanned_pdf which is all this extractor handles)
    let chunks: ArrayBuffer[] = [input.bytes];
    let pageCount = 0;
    
    // Dynamically skip chunking for models with massive context windows
    const isMassiveContextModel = model.includes('gemini-3.5-flash') || model.includes('claude-3.5-sonnet');

    try {
      const pdfDoc = await PDFDocument.load(input.bytes, { ignoreEncryption: true });
      pageCount = pdfDoc.getPageCount();
      const MAX_PAGES = 15;
      if (pageCount > MAX_PAGES && !isMassiveContextModel) {
        chunks = [];
        for (let i = 0; i < pageCount; i += MAX_PAGES) {
          const end = Math.min(i + MAX_PAGES, pageCount);
          const newPdf = await PDFDocument.create();
          const copiedPages = await newPdf.copyPages(pdfDoc, Array.from({ length: end - i }, (_, idx) => i + idx));
          copiedPages.forEach((page) => newPdf.addPage(page));
          const newBytes = await newPdf.save();
          chunks.push((newBytes.buffer as ArrayBuffer).slice(newBytes.byteOffset, newBytes.byteOffset + newBytes.byteLength));
        }
      }
    } catch (err) {
      console.warn(`${this.name}: Failed to parse PDF for chunking (${(err as Error).message}), falling back to raw bytes`);
    }

    let allRows: ParsedTx[] = [];
    let combinedRaw = '';
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalCachedTokens = 0;
    let resolvedModel = model;
    let providerRequestId: string | undefined;

    for (let i = 0; i < chunks.length; i++) {
      try {
        const chunkBytes = chunks[i];
        const prompt = input.filing.chamber === 'executive' ? EXECUTIVE_SYSTEM_PROMPT : SYSTEM_PROMPT;
        const ai = new GoogleGenAI({
          apiKey: key,
        });

        let res;
        try {
          res = await ai.models.generateContent({
            model: model,
            contents: [
              {
                role: 'user',
                parts: [
                  { text: prompt },
                  {
                    inlineData: {
                      mimeType: 'application/pdf',
                      data: arrayBufferToBase64(chunkBytes),
                    },
                  },
                ],
              },
            ],
            config: {
              temperature: 0,
              responseMimeType: 'application/json',
              responseSchema: RESPONSE_SCHEMA as any,
            }
          });
        } catch (e: any) {
          throw e;
        }

        if (res.modelVersion) {
          resolvedModel = res.modelVersion;
        }
        if ((res as any).responseId) {
          providerRequestId = (res as any).responseId;
        }

        const jsonText = res.text;

        if (res.usageMetadata) {
          totalPromptTokens += res.usageMetadata.promptTokenCount ?? 0;
          totalCompletionTokens +=
            (res.usageMetadata.candidatesTokenCount ?? 0) +
            (res.usageMetadata.thoughtsTokenCount ?? 0);
          totalCachedTokens += res.usageMetadata.cachedContentTokenCount ?? 0;
        }

        if (!jsonText) {
          throw new Error(`${this.name}: Gemini returned no candidate text for chunk ${i + 1}/${chunks.length}`);
        }

        combinedRaw += (i > 0 ? '\n\n--- CHUNK ---\n\n' : '') + jsonText;

        let parsed;
        try {
          parsed = parseModelJson(jsonText);
        } catch (err) {
          throw new Error(`${this.name}: could not parse model JSON in chunk ${i + 1}/${chunks.length}: ${(err as Error).message}`);
        }

        allRows.push(...parsed.map(toParsedTx));
      } catch (error) {
        // Any prior successful chunk was already billed. Attach the aggregate
        // provider usage to every later failure path (HTTP, JSON decode,
        // response validation, or row mapping), not only model-JSON failures.
        const failure = error instanceof Error ? error : new Error(String(error));
        throw Object.assign(failure, {
          ...(totalPromptTokens + totalCompletionTokens + totalCachedTokens > 0
            ? {
                usage: {
                  promptTokens: totalPromptTokens,
                  completionTokens: totalCompletionTokens,
                  cachedTokens: totalCachedTokens,
                },
              }
            : {}),
          resolvedModel,
          providerRequestId,
        });
      }
    }

    const docConfidence =
      allRows.length > 0
        ? allRows.reduce((s, r) => s + r.confidence, 0) / allRows.length
        : DEFAULT_CONFIDENCE;

    const usage = totalPromptTokens > 0 || totalCompletionTokens > 0
      ? {
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          cachedTokens: totalCachedTokens,
        }
      : undefined;

    return {
      transactions: allRows,
      confidence: docConfidence,
      raw: combinedRaw,
      extractor: this.name,
      modelVersion: resolvedModel,
      providerRequestId,
      usage,
    };
  }
}

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

/** Stable identifier for the extraction instructions sent to vision models. */
export const EXTRACTION_PROMPT_VERSION = 'stock-act-ptr-v2';

export const SYSTEM_PROMPT = `You are a meticulous data-extraction engine for U.S. congressional STOCK Act
Periodic Transaction Reports (PTRs). The attached document is a scanned PTR.
Extract EVERY disclosed transaction row. For each transaction return:
- txDate: the transaction date in YYYY-MM-DD (use the transaction/trade date, not the notification date). null if illegible.
- owner: one of "self","spouse","joint","dependent" (map SP->spouse, DC->dependent, JT->joint, blank/self->self).
- assetName: the security/asset name as written. null if illegible.
- ticker: the stock ticker symbol in UPPERCASE if shown, else null.
- assetType: short asset-type code/label if shown (e.g. "ST","OP","Stock","Option"), else null.
- assetTypeName: expanded asset-type name if the document or code is clear, else null.
- txType: one of "P" (Purchase), "S" (Sale), "E" (Exchange). null if illegible.
- amountRange: the disclosed amount bracket exactly as printed, e.g. "$1,001 - $15,000" or "$50,000,001 +".
- isOption: true if the holding is an option/call/put/warrant.
- capGainsOver200: true only if a ">$200" capital-gains box/flag is checked.
- filingStatus: row-specific filing status such as "New", if shown.
- subholding: row-specific account/subholding text, if shown.
- location: row-specific location text, if shown.
- description: row-specific description text, if shown.
- supplementalText: remaining row-specific notes/details that are not already captured; do not include page titles, headers, footers, or generic instructions.
- confidence: YOUR confidence for this row in [0,1], lowering it when handwriting or scan quality is poor.
Return ONLY the structured JSON array. Do not guess values you cannot read; use null instead.`;

export const EXECUTIVE_SYSTEM_PROMPT = `You are a meticulous data-extraction engine for U.S. Executive Branch OGE Form 278-T Periodic Transaction Reports.
The attached document is a scanned OGE Form 278-T.
Extract EVERY disclosed transaction row. For each transaction return:
- txDate: the transaction date in YYYY-MM-DD (use the "Transaction Date", NOT the "Notification Date"). null if illegible.
- owner: one of "self","spouse","joint","dependent" (if unspecified or blank, use "self").
- assetName: the security/asset name as written (often under "Description"). null if illegible.
- ticker: the stock ticker symbol in UPPERCASE if shown, else null.
- assetType: short asset-type code/label if shown (e.g. "Stock", "Option"), else null.
- assetTypeName: expanded asset-type name if the document or code is clear, else null.
- txType: one of "P" (Purchase), "S" (Sale), "E" (Exchange). Map "Purchase" to "P", "Sale" to "S", "Exchange" to "E". null if illegible.
- amountRange: the disclosed amount bracket exactly as printed, e.g. "$1,001 - $15,000" or "$15,001 - $50,000".
- isOption: true if the holding is an option/call/put/warrant.
- capGainsOver200: false (rarely applicable on OGE forms).
- filingStatus: row-specific filing status such as "New", if shown.
- subholding: row-specific account/subholding text, if shown.
- location: row-specific location text, if shown.
- description: row-specific description text, if shown.
- supplementalText: capture the "Notification Date" or other notes here.
- confidence: YOUR confidence for this row in [0,1], lowering it when handwriting or scan quality is poor.
Return ONLY the structured JSON array. Do not guess values you cannot read; use null instead.`;

/** Gemini responseSchema constraining output to our transaction array. */
const RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      txDate: { type: 'STRING', nullable: true },
      owner: { type: 'STRING', enum: ['self', 'spouse', 'joint', 'dependent'], nullable: true },
      assetName: { type: 'STRING', nullable: true },
      ticker: { type: 'STRING', nullable: true },
      assetType: { type: 'STRING', nullable: true },
      assetTypeName: { type: 'STRING', nullable: true },
      txType: { type: 'STRING', enum: ['P', 'S', 'E'], nullable: true },
      amountRange: { type: 'STRING', nullable: true },
      isOption: { type: 'BOOLEAN', nullable: true },
      capGainsOver200: { type: 'BOOLEAN', nullable: true },
      filingStatus: { type: 'STRING', nullable: true },
      subholding: { type: 'STRING', nullable: true },
      location: { type: 'STRING', nullable: true },
      description: { type: 'STRING', nullable: true },
      supplementalText: { type: 'STRING', nullable: true },
      confidence: { type: 'NUMBER' },
    },
    required: ['assetName', 'txType', 'amountRange', 'isOption', 'capGainsOver200'],
  },
} as const;



// ---------------------------------------------------------------------------
// Response mapping
// ---------------------------------------------------------------------------

interface ModelTx {
  txDate?: string | null;
  owner?: string | null;
  assetName?: string | null;
  ticker?: string | null;
  assetType?: string | null;
  assetTypeName?: string | null;
  txType?: string | null;
  amountRange?: string | null;
  isOption?: boolean | null;
  capGainsOver200?: boolean | null;
  filingStatus?: string | null;
  subholding?: string | null;
  location?: string | null;
  description?: string | null;
  supplementalText?: string | null;
  confidence?: number;
}

function extractJsonFallback(text: string): unknown {
  const startIdx = text.search(/[[{]/);
  if (startIdx === -1) return undefined;
  
  const openChar = text[startIdx];
  const closeChar = openChar === '[' ? ']' : '}';
  
  let depth = 0;
  let inString = false;
  let escape = false;
  
  for (let i = startIdx; i < text.length; i++) {
    const char = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === '\\') {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    
    if (!inString) {
      if (char === openChar) depth++;
      else if (char === closeChar) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.substring(startIdx, i + 1));
          } catch {
            return undefined;
          }
        }
      }
    }
  }
  return undefined;
}

export function parseModelJson(text: string): ModelTx[] {
  let cleaned = text.trim();
  // Strip ```json ... ``` fences if the model wrapped them despite the schema.
  cleaned = cleaned.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  
  let value: unknown;
  let parseError: Error | undefined;
  try {
    value = JSON.parse(cleaned);
  } catch (err) {
    parseError = err as Error;
  }

  // If initial JSON.parse failed, try to find a valid JSON array or object
  if (value === undefined) {
    value = extractJsonFallback(cleaned);

    if (value === undefined) {
      throw new Error(`visionLlm: could not parse model JSON: ${parseError?.message}`);
    }
  }

  if (Array.isArray(value)) return value as ModelTx[];
  // Some responses wrap the array, e.g. { transactions: [...] }.
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const v of Object.values(obj)) {
      if (Array.isArray(v)) return v as ModelTx[];
    }
  }
  throw new Error('visionLlm: model JSON was not a transaction array');
}

export function toParsedTx(m: ModelTx): ParsedTx {
  const { min, max } = parseAmountRange(m.amountRange ?? '');
  const modelConf = typeof m.confidence === 'number' ? clamp01(m.confidence) : DEFAULT_CONFIDENCE;
  // Cap vision confidence at the conservative default so scanned docs lean to review.
  const confidence = Math.min(modelConf, DEFAULT_CONFIDENCE);

  const extractionWarnings: ParsedTx['extractionWarnings'] = [];
  if (typeof m.isOption !== 'boolean') extractionWarnings.push('unreadable_is_option');
  if (typeof m.capGainsOver200 !== 'boolean') extractionWarnings.push('unreadable_cap_gains');

  return {
    txDate: m.txDate ?? null,
    owner: normalizeOwner(m.owner),
    assetName: (m.assetName ?? '').trim(),
    ticker: m.ticker ? m.ticker.trim().toUpperCase() : null,
    assetType: m.assetType ?? null,
    assetTypeName: cleanNullable(m.assetTypeName),
    txType: normalizeTxType(m.txType),
    amountMin: min,
    amountMax: max,
    isOption: Boolean(m.isOption),
    capGainsOver200: Boolean(m.capGainsOver200),
    ...(extractionWarnings.length ? { extractionWarnings } : {}),
    rawText: JSON.stringify(m),
    filingStatus: cleanNullable(m.filingStatus),
    subholding: cleanNullable(m.subholding),
    location: cleanNullable(m.location),
    description: cleanNullable(m.description),
    supplementalText: cleanNullable(m.supplementalText),
    confidence,
  };
}

function cleanNullable(value: string | null | undefined): string | null {
  const cleaned = (value ?? '').trim();
  return cleaned || null;
}

function normalizeOwner(raw: string | null | undefined): Owner | null {
  const s = (raw ?? '').toLowerCase();
  if (s === 'spouse') return 'spouse';
  if (s === 'joint') return 'joint';
  if (s === 'dependent' || s === 'child') return 'dependent';
  if (s === 'self') return 'self';
  return null;
}

function normalizeTxType(raw: string | null | undefined): TxType {
  const s = (raw ?? '').toUpperCase();
  if (s === 'P') return 'P';
  if (s === 'S') return 'S';
  if (s === 'E') return 'E';
  // ParsedTx historically narrows this field to TxType, but the shared
  // normalizer must see an invalid value so it can hard-flag unreadable rows.
  return '' as TxType;
}

// ---------------------------------------------------------------------------
// Gemini wire types + helpers
// ---------------------------------------------------------------------------



export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  // btoa is available in the Workers runtime.
  return btoa(binary);
}



function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
