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

/**
 * Gemini model id. Centralized + documented so it is trivial to bump.
 * NOTE: Flash model ids rotate; if calls start 404-ing, update this to the
 * current Flash generation — the request/response contract below is unchanged
 * across Flash generations. Current as of 2026-06: 'gemini-3.5-flash'.
 */
const MODEL = 'gemini-3.5-flash';

const ENDPOINT = (model: string, key: string): string =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
    key,
  )}`;

/** Default confidence floor for vision output (most route to review). */
const DEFAULT_CONFIDENCE = 0.6;

/** Optional overrides for building a second, independent vision extractor. */
export interface VisionLlmOptions {
  /** API key to use instead of env.GEMINI_API_KEY (e.g. ARBITRATION_API_KEY). */
  apiKey?: string;
  /** Model id to use instead of the default (a different model = real cross-check). */
  model?: string;
  /** Override extractor name (so arbitration can tell the two apart). */
  name?: string;
}

export class VisionLlmExtractor implements Extractor {
  readonly name: string;
  private readonly model: string;
  private readonly apiKeyOverride?: string;

  constructor(
    private readonly env: Env,
    options: VisionLlmOptions = {},
  ) {
    this.name = options.name ?? 'visionLlm';
    this.model = options.model ?? MODEL;
    this.apiKeyOverride = options.apiKey;
  }

  canHandle(f: Filing): boolean {
    return f.docKind === 'scanned_pdf';
  }

  async extract(input: ExtractorInput): Promise<ExtractorResult> {
    const key = this.apiKeyOverride ?? this.env.GEMINI_API_KEY;
    if (!key) throw new Error(`${this.name}: API key is not configured`);
    if (!input.bytes) throw new Error(`${this.name}: no bytes provided on ExtractorInput`);

    const body = buildRequestBody(input.bytes);

    const res = await fetch(ENDPOINT(this.model, key), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await safeText(res);
      throw new Error(`${this.name}: Gemini API ${res.status} ${res.statusText} ${detail}`);
    }

    const payload = (await res.json()) as GeminiResponse;
    const jsonText = extractCandidateText(payload);
    if (!jsonText) {
      throw new Error(`${this.name}: Gemini returned no candidate text`);
    }

    const parsed = parseModelJson(jsonText);
    const rows = parsed.map(toParsedTx);

    // Document confidence = mean of per-row confidences (or floor when empty).
    const docConfidence =
      rows.length > 0
        ? rows.reduce((s, r) => s + r.confidence, 0) / rows.length
        : DEFAULT_CONFIDENCE;

    return {
      transactions: rows,
      confidence: docConfidence,
      raw: jsonText,
      extractor: this.name,
      modelVersion: this.model,
    };
  }
}

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a meticulous data-extraction engine for U.S. congressional STOCK Act
Periodic Transaction Reports (PTRs). The attached document is a scanned PTR.
Extract EVERY disclosed transaction row. For each transaction return:
- txDate: the transaction date in YYYY-MM-DD (use the transaction/trade date, not the notification date). null if illegible.
- owner: one of "self","spouse","joint","dependent" (map SP->spouse, DC->dependent, JT->joint, blank/self->self).
- assetName: the security/asset name as written.
- ticker: the stock ticker symbol in UPPERCASE if shown, else null.
- assetType: short asset-type code/label if shown (e.g. "ST","OP","Stock","Option"), else null.
- txType: one of "P" (Purchase), "S" (Sale), "E" (Exchange).
- amountRange: the disclosed amount bracket exactly as printed, e.g. "$1,001 - $15,000" or "$50,000,001 +".
- isOption: true if the holding is an option/call/put/warrant.
- capGainsOver200: true only if a ">$200" capital-gains box/flag is checked.
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
      assetName: { type: 'STRING' },
      ticker: { type: 'STRING', nullable: true },
      assetType: { type: 'STRING', nullable: true },
      txType: { type: 'STRING', enum: ['P', 'S', 'E'] },
      amountRange: { type: 'STRING', nullable: true },
      isOption: { type: 'BOOLEAN' },
      capGainsOver200: { type: 'BOOLEAN' },
      confidence: { type: 'NUMBER' },
    },
    required: ['assetName', 'txType', 'amountRange', 'isOption', 'capGainsOver200'],
  },
} as const;

function buildRequestBody(bytes: ArrayBuffer): GeminiRequest {
  return {
    contents: [
      {
        role: 'user',
        parts: [
          { text: SYSTEM_PROMPT },
          {
            inline_data: {
              mime_type: 'application/pdf',
              data: arrayBufferToBase64(bytes),
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA as unknown as Record<string, unknown>,
    },
  };
}

// ---------------------------------------------------------------------------
// Response mapping
// ---------------------------------------------------------------------------

interface ModelTx {
  txDate?: string | null;
  owner?: string | null;
  assetName?: string;
  ticker?: string | null;
  assetType?: string | null;
  txType?: string;
  amountRange?: string | null;
  isOption?: boolean;
  capGainsOver200?: boolean;
  confidence?: number;
}

function parseModelJson(text: string): ModelTx[] {
  let cleaned = text.trim();
  // Strip ```json ... ``` fences if the model wrapped them despite the schema.
  cleaned = cleaned.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  let value: unknown;
  try {
    value = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`visionLlm: could not parse model JSON: ${(err as Error).message}`);
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

function toParsedTx(m: ModelTx): ParsedTx {
  const { min, max } = parseAmountRange(m.amountRange ?? '');
  const modelConf = typeof m.confidence === 'number' ? clamp01(m.confidence) : DEFAULT_CONFIDENCE;
  // Cap vision confidence at the conservative default so scanned docs lean to review.
  const confidence = Math.min(modelConf, DEFAULT_CONFIDENCE);

  return {
    txDate: m.txDate ?? null,
    owner: normalizeOwner(m.owner),
    assetName: (m.assetName ?? '').trim() || (m.ticker ?? '(unknown)'),
    ticker: m.ticker ? m.ticker.trim().toUpperCase() : null,
    assetType: m.assetType ?? null,
    txType: normalizeTxType(m.txType),
    amountMin: min,
    amountMax: max,
    isOption: Boolean(m.isOption),
    capGainsOver200: Boolean(m.capGainsOver200),
    rawText: JSON.stringify(m),
    confidence,
  };
}

function normalizeOwner(raw: string | null | undefined): Owner | null {
  const s = (raw ?? '').toLowerCase();
  if (s === 'spouse') return 'spouse';
  if (s === 'joint') return 'joint';
  if (s === 'dependent' || s === 'child') return 'dependent';
  if (s === 'self') return 'self';
  return null;
}

function normalizeTxType(raw: string | undefined): TxType {
  const s = (raw ?? '').toUpperCase();
  if (s === 'S') return 'S';
  if (s === 'E') return 'E';
  return 'P';
}

// ---------------------------------------------------------------------------
// Gemini wire types + helpers
// ---------------------------------------------------------------------------

interface GeminiRequest {
  contents: Array<{
    role: string;
    parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }>;
  }>;
  generationConfig: {
    temperature: number;
    responseMimeType: string;
    responseSchema: Record<string, unknown>;
  };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
}

function extractCandidateText(payload: GeminiResponse): string | null {
  const parts = payload.candidates?.[0]?.content?.parts;
  if (!parts) return null;
  const text = parts
    .map((p) => p.text ?? '')
    .join('')
    .trim();
  return text || null;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  // btoa is available in the Workers runtime.
  return btoa(binary);
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '';
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
