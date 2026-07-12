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
import { resolveSecret } from '../secrets/infisical';

/**
 * Gemini model id. Centralized + documented so it is trivial to bump.
 * NOTE: Flash model ids rotate; if calls start 404-ing, update this to the
 * current Flash generation — the request/response contract below is unchanged
 * across Flash generations. Current as of 2026-06: 'gemini-3.5-flash'.
 * Override via env var VISION_PRIMARY_MODEL.
 */
const DEFAULT_MODEL = 'gemini-3.5-flash';

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
    const key = this.apiKeyOverride ?? (await resolveSecret(this.env, this.apiKeyName)).value;
    if (!key) throw new Error(`${this.name}: API key is not configured`);
    if (!input.bytes) throw new Error(`${this.name}: no bytes provided on ExtractorInput`);

    const model = await this.resolveModel();
    const body = buildRequestBody(input.bytes);

    const res = await fetchWithRetry(
      ENDPOINT(model, key),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      this.name,
    );

    if (!res.ok) {
      const detail = await safeText(res);
      throw new Error(`${this.name}: Gemini API ${res.status} ${res.statusText} ${detail}`);
    }

    const payload = (await res.json()) as GeminiResponse;
    const jsonText = extractCandidateText(payload);

    const usage = payload.usageMetadata
      ? {
          promptTokens: payload.usageMetadata.promptTokenCount,
          completionTokens: payload.usageMetadata.candidatesTokenCount,
        }
      : undefined;

    if (!jsonText) {
      throw Object.assign(
        new Error(`${this.name}: Gemini returned no candidate text`),
        { usage }
      );
    }

    let parsed;
    try {
      parsed = parseModelJson(jsonText);
    } catch (err) {
      throw Object.assign(err as Error, { usage });
    }
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
      modelVersion: model,
      usage,
    };
  }
}

// ---------------------------------------------------------------------------
// Transient-failure retry
// ---------------------------------------------------------------------------

/** Retry only 429 (rate limit / quota) — the failure mode that took out ~192
 *  House filings in a backfill burst. 5xx is left to fail fast (rarer, and often
 *  a real provider outage where retrying inline just wastes queue time). */
function isRetryable(status: number): boolean {
  return status === 429;
}

/**
 * Fetch with capped exponential backoff + jitter on retryable statuses, honoring
 * Retry-After. Runs inside the ingest queue consumer (generous per-message
 * duration), so short waits are safe — this turns a Gemini rate-limit BURST
 * (e.g. a bulk backfill firing hundreds of requests at once, which is exactly
 * how ~192 House filings hard-failed with `429 Too Many Requests`) into a brief
 * delay instead of a permanent extraction failure. Injectable `sleep`/`maxAttempts`
 * for tests.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  name = 'fetch',
  opts: { maxAttempts?: number; sleep?: (ms: number) => Promise<void>; jitter?: () => number } = {},
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const jitter = opts.jitter ?? (() => Math.floor(Math.random() * 250));
  let res = await fetch(url, init);
  for (let attempt = 1; attempt < maxAttempts && isRetryable(res.status); attempt++) {
    const retryAfterSec = Number(res.headers.get('retry-after'));
    const backoffMs =
      Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? Math.min(retryAfterSec * 1000, 30_000)
        : Math.min(500 * 2 ** (attempt - 1), 8_000) + jitter();
    // Release the errored response body so the connection can be reused.
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    console.warn(`${name}: ${res.status} — retry ${attempt}/${maxAttempts - 1} in ${backoffMs}ms`);
    await sleep(backoffMs);
    res = await fetch(url, init);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = `You are a meticulous data-extraction engine for U.S. congressional STOCK Act
Periodic Transaction Reports (PTRs). The attached document is a scanned PTR.
Extract EVERY disclosed transaction row. For each transaction return:
- txDate: the transaction date in YYYY-MM-DD (use the transaction/trade date, not the notification date). null if illegible.
- owner: one of "self","spouse","joint","dependent" (map SP->spouse, DC->dependent, JT->joint, blank/self->self).
- assetName: the security/asset name as written.
- ticker: the stock ticker symbol in UPPERCASE if shown, else null.
- assetType: short asset-type code/label if shown (e.g. "ST","OP","Stock","Option"), else null.
- assetTypeName: expanded asset-type name if the document or code is clear, else null.
- txType: one of "P" (Purchase), "S" (Sale), "E" (Exchange).
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
      assetTypeName: { type: 'STRING', nullable: true },
      txType: { type: 'STRING', enum: ['P', 'S', 'E'] },
      amountRange: { type: 'STRING', nullable: true },
      isOption: { type: 'BOOLEAN' },
      capGainsOver200: { type: 'BOOLEAN' },
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
  assetTypeName?: string | null;
  txType?: string;
  amountRange?: string | null;
  isOption?: boolean;
  capGainsOver200?: boolean;
  filingStatus?: string | null;
  subholding?: string | null;
  location?: string | null;
  description?: string | null;
  supplementalText?: string | null;
  confidence?: number;
}

export function parseModelJson(text: string): ModelTx[] {
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

export function toParsedTx(m: ModelTx): ParsedTx {
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
    assetTypeName: cleanNullable(m.assetTypeName),
    txType: normalizeTxType(m.txType),
    amountMin: min,
    amountMax: max,
    isOption: Boolean(m.isOption),
    capGainsOver200: Boolean(m.capGainsOver200),
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
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
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
