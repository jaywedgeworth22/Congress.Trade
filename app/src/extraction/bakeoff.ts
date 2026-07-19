/**
 * src/extraction/bakeoff.ts
 *
 * Provider-neutral extraction bake-off. Runs the SAME House PTR PDFs through
 * several vision models (Gemini, OpenAI, Anthropic, Mistral, xAI) using one shared prompt, so
 * we can compare extraction quality before committing the whole House corpus to
 * one model. Each provider is a thin raw-`fetch` adapter (matching the existing
 * visionLlm.ts style — no SDK in the Worker); the shared JSON parser turns every
 * provider's reply into ParsedTx[].
 *
 * Without a hand-labelled answer key we can't score absolute accuracy, so the
 * harness reports the signals that ARE measurable per model: row recall (rows
 * found), malformed-JSON / API failures, latency, and cross-model agreement
 * (how much each model's rows line up with the consensus). The pure aggregation
 * helpers (summarizeModels / computeConsensusAgreement) are unit-tested.
 */

import type { Env, ParsedTx } from '../shared/types';
import { arbitrationRowKey } from '../extractors/types';
import {
  SYSTEM_PROMPT,
  EXECUTIVE_SYSTEM_PROMPT,
  parseModelJson,
  parseAnthropicModelJson,
  markSalvaged,
  validatePdfForAnthropic,
  resavePdfForAnthropic,
  isAnthropicInvalidPdfError,
  toParsedTx,
  arrayBufferToBase64,
  VisionLlmExtractor,
} from './visionLlm';
import { resolveSecret } from '../secrets/infisical';
import { run } from '../shared/db';
import { uuid } from '../shared/ids';
import { trackedFetch } from '../shared/thirdPartyTelemetry';
import { pushExtractionTelemetry } from './telemetry';
import { OpenRouterVisionExtractor } from './openRouterVision';
import {
  classifyProviderFailure,
  type ProviderFailureStatus,
} from './providerFailure';

export type Provider = 'gemini' | 'openai' | 'anthropic' | 'mistral' | 'xai' | 'llamaparse' | 'openrouter';

export interface BakeoffCandidate {
  provider: Provider;
  model: string;
}

/**
 * Frozen provider credential decision for one candidate invocation. Passing a
 * plan prevents a later secret-cache refresh from changing whether the paid
 * call happens after the caller has confirmed/reserved it.
 */
export interface CandidateInvocation {
  apiKey: string | null;
  /** Skip prior successful extraction rows when current latency/usage/cost
   *  measurements require a real provider invocation. */
  skipCache?: boolean;
}

/**
 * Default extraction lineup (overridable per request). Per owner directive, ALL
 * LLM extraction routes through OpenRouter for unified billing + observability:
 * every entry below is an `openrouter:*` transport and there are ZERO
 * direct-provider entries. The direct provider keys (Google/OpenAI/Anthropic/
 * Mistral/xAI) are being removed from the offered catalog; llamaparse is the sole
 * remaining DIRECT transport — a non-LLM document parser kept in
 * LLAMAPARSE_CANDIDATES (see benchmark/settings.ts). Historical extraction_runs
 * that reference direct providers still DECODE/replay via runCandidateOnDoc's
 * direct-provider dispatch and the LEGACY_CANDIDATES catalog entries: only which
 * models are OFFERED changes here, not decode support.
 *
 * The GPT-4o family is intentionally absent from new disclosure extraction (see
 * isRetiredDisclosureCandidate): GPT-5.6 Terra is the routine default, Luna is
 * the lower-cost first pass, Sol is the difficult-scan adjudicator, and terra-pro
 * is the higher-effort variant.
 *
 * `mistral/mistral-ocr-latest` is NOT a listed OpenRouter chat model — the
 * OpenRouter vision adapter (openRouterVision.ts) special-cases it as the
 * mistral-ocr file-parser plugin, so it MUST stay this exact slug. Every other
 * openrouter slug was verified LIVE against the OpenRouter models API (2026-07-16
 * for the pre-existing set; terra-pro and claude-haiku-4.5 verified 2026-07-17).
 * Note claude-haiku-4.5 uses a DOT — `anthropic/claude-haiku-4-5` (dash) does not
 * exist on OpenRouter. Slugs confirmed absent from the live API (gemini-pro-1.5 /
 * flash-1.5 / 2.0-flash-thinking-exp, claude-3.5/3.7 family, mistral-large-2411,
 * grok-2-vision-1212, qwen-2.5-vl-72b:free, qwen-max, yi-large, kimi-chat,
 * minimax-hep-lite, deepseek-chat/-coder) must never reappear — every benchmark
 * cell for a dead slug can only fail. `google/gemini-3.5-flash` is the OR-transport
 * route around the blocked direct Gemini key.
 */
export const DEFAULT_CANDIDATES: BakeoffCandidate[] = [
  // Mistral OCR via the OpenRouter mistral-ocr file-parser plugin (see
  // openRouterVision.ts) — replaces the former native `mistral:mistral-ocr-latest`
  // direct route; the direct entry lives in LEGACY_CANDIDATES for decode only.
  { provider: 'openrouter', model: 'mistral/mistral-ocr-latest' },
  { provider: 'openrouter', model: 'openai/gpt-5.6-terra' },
  { provider: 'openrouter', model: 'openai/gpt-5.6-luna' },
  { provider: 'openrouter', model: 'anthropic/claude-sonnet-5' },
  { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' },
  { provider: 'openrouter', model: 'anthropic/claude-opus-4.8' },
  { provider: 'openrouter', model: 'x-ai/grok-4.3' },
  { provider: 'openrouter', model: 'deepseek/deepseek-v4-pro' },
  { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash' },
  { provider: 'openrouter', model: 'qwen/qwen3-vl-30b-a3b-instruct' },
  { provider: 'openrouter', model: 'qwen/qwen3-vl-8b-instruct' },
  { provider: 'openrouter', model: 'google/gemini-2.5-flash-lite' },
  { provider: 'openrouter', model: 'amazon/nova-lite-v1' },
  { provider: 'openrouter', model: 'z-ai/glm-4.6v' },
  { provider: 'openrouter', model: 'google/gemini-3.5-flash' },
  { provider: 'openrouter', model: 'qwen/qwen-2.5-72b-instruct' },
];

/**
 * Known-good routes kept catalog-valid (decode/replay + one-line re-enable)
 * but intentionally NOT offered in the benchmark UI and NOT part of the
 * default bake-off lineup.
 */
export const NON_OFFERED_CANDIDATES: BakeoffCandidate[] = [
  // Routing is unpredictable; owner will trial it separately, not alongside
  // fixed-model benchmarking. Already rejected for live A–E slots by
  // isOpenRouterAuto() and by CODEX PR #556's dry-run guard.
  { provider: 'openrouter', model: 'openrouter/auto' },
  // Vision extraction/OCR tasks typically do not benefit from higher-cost
  // reasoning models. Removed to prevent routine benchmark waste, but kept
  // in catalog for targeted or historical runs.
  { provider: 'openrouter', model: 'openai/gpt-5.6-terra-pro' },
  { provider: 'openrouter', model: 'openai/gpt-5.6-sol' },
];

/**
 * GPT-4o is retained only for decoding/replaying historical extraction runs.
 * The retirement (PR #414) covers both transports: the direct OpenAI provider
 * and OpenRouter-transported `openai/gpt-4o*` / `openai/chatgpt-4o*` slugs.
 */
export function isRetiredDisclosureCandidate(candidate: Pick<BakeoffCandidate, 'provider' | 'model'>): boolean {
  const model = candidate.model.trim();
  if (candidate.provider === 'openai') return /^(?:gpt|chatgpt)-4o(?:-|$)/i.test(model);
  if (candidate.provider === 'openrouter') return /^openai\/(?:gpt|chatgpt)-4o(?:-|$)/i.test(model);
  return false;
}

/** Upgrade stale agreement configuration without rewriting historical run records. */
export function upgradeRetiredDisclosureCandidate(candidate: BakeoffCandidate): BakeoffCandidate {
  if (!isRetiredDisclosureCandidate(candidate)) return candidate;
  return candidate.provider === 'openrouter'
    ? { provider: 'openrouter', model: 'openai/gpt-5.6-terra' }
    : { provider: 'openai', model: 'gpt-5.6-terra' };
}

/** Production reasoning profile for the three GPT-5.6 scanned-document roles. */
export function openAiDisclosureReasoningEffort(model: string): 'low' | 'medium' | 'high' {
  if (model.startsWith('gpt-5.6-sol')) return 'high';
  if (model.startsWith('gpt-5.6-luna')) return 'low';
  return 'medium';
}

/** One model's run over one document. */
export interface CandidateDocResult {
  provider: Provider;
  model: string;
  docId: string;
  ok: boolean;
  error?: string;
  /** Stable, secret-safe reason when another request would deterministically fail. */
  failure?: ProviderFailureStatus;
  latencyMs: number;
  rowCount: number;
  /** Stable row keys (ticker/name|date|type) for agreement scoring. */
  rowKeys: string[];
  /** Mean per-row extractor confidence in [0,1] (0 when no rows / failed). */
  avgConfidence: number;
  /** The model's extracted rows, retained so the bake-off can persist each reading. */
  rows: ParsedTx[];
  /** Concrete model/version and request id returned by the provider, when available. */
  resolvedModel?: string;
  providerRequestId?: string;
  /** Stable start time for measured usage emitted from this provider attempt. */
  occurredAt?: string;
  /** Effective request tier returned by the provider (for example OpenAI `default`). */
  serviceTier?: string;
  /** Billed usage reported by the provider API. */
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    cachedTokens?: number;
    cacheWriteTokens?: number;
    cacheWriteOneHourTokens?: number;
    pagesProcessed?: number;
    /** Exact xAI request charge; 1 USD = 10^10 ticks. Includes server-side tools. */
    costInUsdTicks?: number;
    /** Successful billable attachment_search calls reported for an xAI file request. */
    attachmentSearchCalls?: number;
    /** Effective provider tier, included with the usage snapshot for cost provenance. */
    serviceTier?: string;
  };
  /** Indicates if this result was loaded from the extraction_runs cache (prevents duplicate db inserts) */
  cached?: boolean;
}

/** Per-model rollup across all documents. */
export interface ModelSummary {
  provider: Provider;
  model: string;
  label: string;
  docsAttempted: number;
  docsOk: number;
  failures: number;
  totalRows: number;
  avgRowsPerOkDoc: number;
  avgLatencyMs: number;
  /** Mean fraction of the per-doc consensus rows this model recovered, [0,1]. */
  consensusAgreement: number;
}

const label = (c: { provider: Provider; model: string }): string => `${c.provider}:${c.model}`;

// ---------------------------------------------------------------------------
// Provider adapters — each returns the raw model reply text (a JSON array).
// ---------------------------------------------------------------------------

/** Resolve the API key for a provider, or null when it isn't configured. */
export async function keyFor(env: Env, provider: Provider): Promise<string | null> {
  if (provider === 'gemini') return (await resolveSecret(env, 'GEMINI_API_KEY')).value ?? null;
  if (provider === 'openai') return (await resolveSecret(env, 'OPENAI_API_KEY')).value ?? null;
  if (provider === 'anthropic') return (await resolveSecret(env, 'ANTHROPIC_API_KEY')).value ?? null;
  if (provider === 'mistral') return (await resolveSecret(env, 'MISTRAL_API_KEY')).value ?? null;
  if (provider === 'xai') return (await resolveSecret(env, 'XAI_API_KEY')).value ?? null;
  if (provider === 'openrouter') return (await resolveSecret(env, 'OPENROUTER_API_KEY')).value ?? null;
  if (provider === 'llamaparse') {
    return (await resolveSecret(env, 'LLAMAPARSE_API_KEY')).value ?? null;
  }
  return null;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 400);
  } catch {
    return '';
  }
}

/** Token usage extracted from a provider response, shared shape across providers. */
type UsageInfo = CandidateDocResult['usage'];

interface ProviderResult {
  rows: ParsedTx[];
  usage?: UsageInfo;
  resolvedModel?: string;
  providerRequestId?: string;
  serviceTier?: string;
}

type ProviderError = Error & {
  usage?: UsageInfo;
  resolvedModel?: string;
  providerRequestId?: string;
  serviceTier?: string;
  /** True once an asynchronous provider accepted a potentially billable job. */
  acceptedJob?: boolean;
};

function providerError(error: Error, metadata: Omit<ProviderResult, 'rows'>): ProviderError {
  return Object.assign(error, metadata);
}

/** Pull text from the Responses API's convenience or content-block shape. */
export function extractResponsesText(payload: unknown, provider = 'responses'): string {
  const p = (payload ?? {}) as {
    output_text?: unknown;
    output?: Array<{ content?: Array<{ text?: string }> }>;
  };
  if (typeof p.output_text === 'string' && p.output_text.trim()) return p.output_text.trim();
  const text = (p.output ?? [])
    .flatMap((item) => item.content ?? [])
    .map((content) => content.text ?? '')
    .join('')
    .trim();
  if (!text) throw new Error(`${provider}: no text in /v1/responses output`);
  return text;
}

/**
 * OpenAI PDF vision call. GPT-5.6 uses Responses with high-detail page
 * images (important for handwriting and small print). A legacy Chat Completions
 * shape remains for non-retired compatibility models; GPT-4o is rejected before
 * this adapter can make a provider request.
 */
async function runOpenAi(
  model: string,
  key: string,
  bytes: ArrayBuffer,
  chamber: string,
): Promise<ProviderResult> {
  const dataUrl = `data:application/pdf;base64,${arrayBufferToBase64(bytes)}`;
  const prompt = chamber === 'executive' ? EXECUTIVE_SYSTEM_PROMPT : SYSTEM_PROMPT;
  const useResponses = model.startsWith('gpt-5.6');
  const endpoint = useResponses
    ? 'https://api.openai.com/v1/responses'
    : 'https://api.openai.com/v1/chat/completions';
  const body = useResponses
    ? {
        model,
        service_tier: 'default',
        reasoning: { effort: openAiDisclosureReasoningEffort(model) },
        max_output_tokens: 8_000,
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_file', filename: 'ptr.pdf', file_data: dataUrl, detail: 'high' },
              { type: 'input_text', text: `${prompt}\nReturn ONLY a JSON object {"transactions": [...]} .` },
            ],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: MISTRAL_ANNOTATION_SCHEMA.name,
            strict: true,
            schema: MISTRAL_ANNOTATION_SCHEMA.schema,
          },
        },
        store: false,
      }
    : {
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: `${prompt}\nReturn a JSON object {"transactions": [...]} .` },
              { type: 'file', file: { filename: 'ptr.pdf', file_data: dataUrl } },
            ],
          },
        ],
      };
  const res = await trackedFetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  }, { service: 'llm', operation: 'extract-document', model });
  if (!res.ok) throw new Error(`openai ${res.status} ${await safeText(res)}`);
  const payload = (await res.json()) as {
    id?: string;
    model?: string;
    service_tier?: string;
    status?: string;
    incomplete_details?: { reason?: string } | null;
    error?: { code?: string; message?: string } | null;
    choices?: Array<{ message?: { content?: string } }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    };
    output_text?: unknown;
    output?: Array<{
      content?: Array<{ type?: string; text?: string; refusal?: string }>;
    }>;
  };
  // Extract usage *before* parsing so it survives parse failures.
  const usageInfo = payload.usage || payload.service_tier
    ? {
        promptTokens: useResponses ? payload.usage?.input_tokens : payload.usage?.prompt_tokens,
        completionTokens: useResponses ? payload.usage?.output_tokens : payload.usage?.completion_tokens,
        cachedTokens: useResponses
          ? payload.usage?.input_tokens_details?.cached_tokens
          : payload.usage?.prompt_tokens_details?.cached_tokens,
        cacheWriteTokens: useResponses
          ? payload.usage?.input_tokens_details?.cache_write_tokens
          : payload.usage?.prompt_tokens_details?.cache_write_tokens,
        serviceTier: payload.service_tier,
      }
    : undefined;

  const metadata = {
    usage: usageInfo,
    resolvedModel: payload.model,
    providerRequestId: payload.id,
    serviceTier: payload.service_tier,
  };

  if (useResponses && payload.status && payload.status !== 'completed') {
    const detail = payload.incomplete_details?.reason ?? payload.error?.message ?? payload.error?.code;
    throw providerError(
      new Error(`openai: response ${payload.status}${detail ? `: ${detail}` : ''}`),
      metadata,
    );
  }

  const refusal = useResponses
    ? (payload.output ?? [])
        .flatMap((item) => item.content ?? [])
        .map((content) => content.refusal?.trim())
        .find((value): value is string => Boolean(value))
    : undefined;
  if (refusal) {
    throw providerError(new Error(`openai: refusal: ${refusal}`), metadata);
  }

  const text = useResponses
    ? (() => {
        try {
          return extractResponsesText(payload, 'openai');
        } catch {
          return undefined;
        }
      })()
    : payload.choices?.[0]?.message?.content;
  if (!text) {
    throw providerError(new Error('openai: empty completion'), metadata);
  }

  try {
    return {
      rows: parseModelJson(text).map(toParsedTx),
      usage: usageInfo,
      resolvedModel: payload.model,
      providerRequestId: payload.id,
      serviceTier: payload.service_tier,
    };
  } catch (parseErr) {
    // Parse failed but tokens were still consumed — attach usage to the error
    // so runCandidateOnDoc can persist it alongside the failure.
    throw providerError(
      new Error(`openai: parse error: ${(parseErr as Error).message}`),
      metadata,
    );
  }
}

interface AnthropicMessagesPayload {
  id?: string;
  model?: string;
  content?: Array<{ type: string; text?: string }>;
  /** 'max_tokens' means the response was cut off before completion. */
  stop_reason?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation?: {
      ephemeral_5m_input_tokens?: number;
      ephemeral_1h_input_tokens?: number;
    } | null;
  };
}

/** Map an Anthropic Messages `usage` block to the shared UsageInfo shape. */
function anthropicUsageFromPayload(usage: AnthropicMessagesPayload['usage']): UsageInfo {
  if (!usage) return undefined;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
  const cacheWriteOneHourTokens = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const cacheWriteTokens = usage.cache_creation?.ephemeral_5m_input_tokens
    ?? Math.max(0, cacheCreationTokens - cacheWriteOneHourTokens);
  return {
    promptTokens: (usage.input_tokens ?? 0) + cacheReadTokens + cacheCreationTokens,
    completionTokens: usage.output_tokens,
    cachedTokens: cacheReadTokens,
    cacheWriteTokens,
    cacheWriteOneHourTokens,
  };
}

/** Sum two Anthropic usage snapshots (first-call + retry-call both billed). */
function sumUsageInfo(a: UsageInfo, b: UsageInfo): UsageInfo {
  if (!a) return b;
  if (!b) return a;
  return {
    promptTokens: (a.promptTokens ?? 0) + (b.promptTokens ?? 0),
    completionTokens: (a.completionTokens ?? 0) + (b.completionTokens ?? 0),
    cachedTokens: (a.cachedTokens ?? 0) + (b.cachedTokens ?? 0),
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
    cacheWriteOneHourTokens: (a.cacheWriteOneHourTokens ?? 0) + (b.cacheWriteOneHourTokens ?? 0),
  };
}

/** First-call token budget. Kept modest to protect cost on the common case. */
const ANTHROPIC_MAX_TOKENS = 8000;
/** Retry budget when the first call was cut off (`stop_reason: 'max_tokens'`). */
const ANTHROPIC_MAX_TOKENS_RETRY = 16000;

/**
 * Anthropic messages call (base64 `document` block BEFORE the text block).
 *
 * PDF bytes are pre-validated (pdf-lib load only, bytes unchanged) before any
 * request is sent (see {@link validatePdfForAnthropic}); an unparseable PDF
 * fails fast without spending a provider call. The ORIGINAL bytes are sent —
 * NOT pdf-lib's resaved/re-serialized output (see {@link validatePdfForAnthropic}
 * for why: Anthropic's parser rejects pdf-lib's serializer output for some
 * PDFs it accepts in original form). If Anthropic 400s specifically with the
 * receipted invalid-PDF message (see {@link isAnthropicInvalidPdfError}), one
 * repair retry is made with {@link resavePdfForAnthropic}'s resaved bytes; if
 * that retry also fails, the ORIGINAL error is surfaced.
 *
 * Independently, when the model's first reply is cut off (`stop_reason:
 * 'max_tokens'`), one retry is made with a doubled token budget; if the retry
 * is STILL truncated (or the JSON is truncated and unparseable), a bounded
 * salvage recovers the complete leading transaction rows instead of failing
 * the whole read (see {@link parseAnthropicModelJson}).
 */
async function runAnthropic(
  model: string,
  key: string,
  bytes: ArrayBuffer,
  chamber: string,
): Promise<ProviderResult> {
  const prompt = chamber === 'executive' ? EXECUTIVE_SYSTEM_PROMPT : SYSTEM_PROMPT;
  await validatePdfForAnthropic(bytes);

  const callAnthropic = async (documentBase64: string, maxTokens: number): Promise<AnthropicMessagesPayload> => {
    const res = await trackedFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: documentBase64 },
              },
              { type: 'text', text: `${prompt}\nReturn ONLY the JSON array.` },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    }, { service: 'llm', operation: 'extract-document', model });
    if (!res.ok) throw new Error(`anthropic ${res.status} ${await safeText(res)}`);
    return (await res.json()) as AnthropicMessagesPayload;
  };

  /** One full call (+ truncation retry) attempt against a given byte source. */
  const attempt = async (
    pdfBytes: ArrayBuffer,
  ): Promise<{ payload: AnthropicMessagesPayload; usageInfo: UsageInfo }> => {
    const documentBase64 = arrayBufferToBase64(pdfBytes);
    let payload = await callAnthropic(documentBase64, ANTHROPIC_MAX_TOKENS);
    let usageInfo = anthropicUsageFromPayload(payload.usage);

    if (payload.stop_reason === 'max_tokens') {
      const retryPayload = await callAnthropic(documentBase64, ANTHROPIC_MAX_TOKENS_RETRY);
      usageInfo = sumUsageInfo(usageInfo, anthropicUsageFromPayload(retryPayload.usage));
      payload = retryPayload;
    }
    return { payload, usageInfo };
  };

  let payload: AnthropicMessagesPayload;
  let usageInfo: UsageInfo;
  try {
    ({ payload, usageInfo } = await attempt(bytes));
  } catch (err) {
    // Repair retry: Anthropic's parser sometimes rejects previously-good PDF
    // bytes outright (receipted 2026-07-15 doc H-2026-20034954 production
    // regression). One shot only — resave via pdf-lib and retry ONCE; if the
    // retry also fails (for this reason or any other), surface the ORIGINAL
    // error, not the retry's.
    if (!isAnthropicInvalidPdfError((err as Error).message)) throw err;
    try {
      const resavedBytes = await resavePdfForAnthropic(bytes);
      ({ payload, usageInfo } = await attempt(resavedBytes));
    } catch {
      throw err;
    }
  }

  const text = (payload.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim();
  if (!text) {
    throw providerError(new Error('anthropic: no text block'), {
      usage: usageInfo,
      resolvedModel: payload.model,
      providerRequestId: payload.id,
    });
  }

  try {
    const { rows: modelRows, salvaged } = parseAnthropicModelJson(text, payload.stop_reason);
    const rows = modelRows.map(toParsedTx).map((tx) => (salvaged ? markSalvaged(tx) : tx));
    return {
      rows,
      usage: usageInfo,
      resolvedModel: payload.model,
      providerRequestId: payload.id,
    };
  } catch (err) {
    throw providerError(err as Error, {
      usage: usageInfo,
      resolvedModel: payload.model,
      providerRequestId: payload.id,
    });
  }
}

/** Stable identifier for the structured transaction schema sent to OCR/LLM providers. */
export const EXTRACTION_SCHEMA_VERSION = 'stock-act-transactions-v2';

/**
 * JSON-schema for Mistral's `document_annotation` — a doc-wide structured
 * extraction whose field names match {@link toParsedTx}'s `ModelTx` input, so
 * the shared parser maps it like every other provider.
 */
export const MISTRAL_ANNOTATION_SCHEMA = {
  name: 'congress_ptr_transactions',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      transactions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            txDate: { type: ['string', 'null'] },
            owner: { type: ['string', 'null'] },
            assetName: { type: ['string', 'null'] },
            ticker: { type: ['string', 'null'] },
            assetType: { type: ['string', 'null'] },
            assetTypeName: { type: ['string', 'null'] },
            txType: { type: ['string', 'null'] },
            amountRange: { type: ['string', 'null'] },
            isOption: { type: ['boolean', 'null'] },
            capGainsOver200: { type: ['boolean', 'null'] },
            filingStatus: { type: ['string', 'null'] },
            subholding: { type: ['string', 'null'] },
            location: { type: ['string', 'null'] },
            description: { type: ['string', 'null'] },
            supplementalText: { type: ['string', 'null'] },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
          },
          required: [
            'assetName',
            'ticker',
            'assetType',
            'assetTypeName',
            'txType',
            'amountRange',
            'txDate',
            'owner',
            'isOption',
            'capGainsOver200',
            'filingStatus',
            'subholding',
            'location',
            'description',
            'supplementalText',
            'confidence',
          ],
        },
      },
    },
    required: ['transactions'],
  },
} as const;

/**
 * Map a Mistral `/v1/ocr` response to ParsedTx[]. Prefers the structured
 * `document_annotation` (a JSON string or object); falls back to a fenced JSON
 * block embedded in the OCR markdown. Separated from the network call so the
 * mapping is unit-testable without a live key. Exported for tests.
 */
export function parseMistralOcrResponse(payload: unknown): ParsedTx[] {
  const p = (payload ?? {}) as { document_annotation?: unknown; pages?: Array<{ markdown?: string }> };
  if (p.document_annotation != null) {
    const text =
      typeof p.document_annotation === 'string'
        ? p.document_annotation
        : JSON.stringify(p.document_annotation);
    return parseModelJson(text).map(toParsedTx);
  }
  const markdown = (p.pages ?? []).map((pg) => pg.markdown ?? '').join('\n');
  const fenced = markdown.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return parseModelJson(fenced[1]).map(toParsedTx);
  throw new Error('mistral: no document_annotation or JSON block in OCR output');
}

/**
 * Mistral OCR call. Unlike the chat-style providers, `/v1/ocr` natively accepts
 * a base64 PDF as a `document_url` and returns a doc-wide structured annotation
 * when `document_annotation_format` is supplied.
 */
async function runMistral(model: string, key: string, bytes: ArrayBuffer): Promise<ProviderResult> {
  const dataUrl = `data:application/pdf;base64,${arrayBufferToBase64(bytes)}`;
  const res = await trackedFetch('https://api.mistral.ai/v1/ocr', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      document: { type: 'document_url', document_url: dataUrl },
      document_annotation_format: { type: 'json_schema', json_schema: MISTRAL_ANNOTATION_SCHEMA },
      include_image_base64: false,
    }),
    signal: AbortSignal.timeout(120_000),
  }, { service: 'ocr', operation: 'extract-document', model });
  if (!res.ok) throw new Error(`mistral ${res.status} ${await safeText(res)}`);
  const payload = (await res.json()) as {
    id?: string;
    model?: string;
    usage_info?: { pages_processed?: number };
  };
  const usageInfo = payload.usage_info?.pages_processed != null
    ? { pagesProcessed: payload.usage_info.pages_processed }
    : undefined;

  try {
    return {
      rows: parseMistralOcrResponse(payload),
      usage: usageInfo,
      resolvedModel: payload.model,
      providerRequestId: payload.id,
    };
  } catch (err) {
    throw providerError(err as Error, {
      usage: usageInfo,
      resolvedModel: payload.model,
      providerRequestId: payload.id,
    });
  }
}

/**
 * Pull the assistant text out of an xAI `/v1/responses` payload. Prefers the
 * convenience `output_text`, else concatenates the `output[].content[].text`
 * parts (the Responses-API message shape). Separated for unit testing.
 */
export function extractXaiResponseText(payload: unknown): string {
  return extractResponsesText(payload, 'xai');
}

/**
 * xAI Grok via the Files API. Unlike the inline-base64 providers, Grok needs the
 * PDF uploaded first (`POST /v1/files`), then the returned `file_id` attached to
 * an agentic `/v1/responses` call (grok-4.3), whose server-side OCR+vision reads
 * the scan. Two round-trips, so it's the slowest candidate.
 */
async function runXai(
  model: string,
  key: string,
  bytes: ArrayBuffer,
  chamber: string,
): Promise<ProviderResult> {
  const prompt = chamber === 'executive' ? EXECUTIVE_SYSTEM_PROMPT : SYSTEM_PROMPT;
  let uploadedId: string | null = null;
  try {
    // 1) upload the PDF (multipart/form-data; let fetch set the boundary). The
    // one-hour TTL is a backstop; the finally block below deletes immediately.
    const form = new FormData();
    form.append('purpose', 'assistants');
    form.append('expires_after', '3600');
    form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'ptr.pdf');
    const up = await trackedFetch('https://api.x.ai/v1/files', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    }, { service: 'llm', operation: 'upload-document', model });
    if (!up.ok) throw new Error(`xai upload ${up.status} ${await safeText(up)}`);
    const uploaded = (await up.json()) as { id?: string };
    if (!uploaded.id) throw new Error('xai: upload returned no file id');
    uploadedId = uploaded.id;

    // 2) ask Grok to extract, attaching the uploaded file.
    const res = await trackedFetch('https://api.x.ai/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: `${prompt}\nReturn ONLY a JSON object {"transactions": [...]} .` },
              { type: 'input_file', file_id: uploadedId },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    }, { service: 'llm', operation: 'extract-document', model });
    if (!res.ok) throw new Error(`xai ${res.status} ${await safeText(res)}`);
    const payload = (await res.json()) as {
      id?: string;
      model?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        input_tokens_details?: { cached_tokens?: number };
        cost_in_usd_ticks?: number;
        num_server_side_tools_used?: number;
      };
      output_text?: unknown;
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    // This adapter enables no explicit tools. xAI automatically enables only
    // attachment_search when input_file is attached, so its reported total is
    // a measured attachment-search count rather than an inferred one.
    const reportedToolCalls = payload.usage?.num_server_side_tools_used;
    const attachmentSearchCalls =
      typeof reportedToolCalls === 'number' && Number.isInteger(reportedToolCalls) && reportedToolCalls >= 0
        ? reportedToolCalls
        : undefined;
    const usageInfo = payload.usage
      ? {
          promptTokens: payload.usage.input_tokens,
          completionTokens: payload.usage.output_tokens,
          cachedTokens: payload.usage.input_tokens_details?.cached_tokens,
          costInUsdTicks: payload.usage.cost_in_usd_ticks,
          attachmentSearchCalls,
        }
      : undefined;

    try {
      return {
        rows: parseModelJson(extractXaiResponseText(payload)).map(toParsedTx),
        usage: usageInfo,
        resolvedModel: payload.model,
        providerRequestId: payload.id,
      };
    } catch (err) {
      throw providerError(err as Error, {
        usage: usageInfo,
        resolvedModel: payload.model,
        providerRequestId: payload.id,
      });
    }
  } finally {
    if (uploadedId) {
      try {
        const cleanup = await trackedFetch(
          `https://api.x.ai/v1/files/${encodeURIComponent(uploadedId)}`,
          {
            method: 'DELETE',
            headers: { authorization: `Bearer ${key}` },
            signal: AbortSignal.timeout(120_000),
          },
          { service: 'llm', operation: 'delete-document', model },
        );
        if (!cleanup.ok) {
          console.error('xai uploaded-file cleanup failed', { status: cleanup.status });
        }
      } catch (error) {
        // Cleanup telemetry is emitted by trackedFetch. Preserve the extraction
        // result while the one-hour upload TTL bounds any residual storage.
        console.error('xai uploaded-file cleanup failed', {
          error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// LlamaParse provider — OCR + LLM-guided structured extraction via
// https://api.cloud.llamaindex.ai/api/v1/parsing. The `parsing_instruction`
// directs LlamaParse's internal model to emit a JSON array in a fenced block;
// `parseLlamaParseMarkdown` then extracts it using the same regex path as the
// Mistral markdown fallback. Two round-trips: upload → poll → fetch markdown.
// ---------------------------------------------------------------------------

const LLAMAPARSE_BASE = 'https://api.cloud.llamaindex.ai/api/v1/parsing';

/**
 * Instruction appended to SYSTEM_PROMPT when submitting to LlamaParse. Asks
 * the parser's internal LLM to embed the transaction array in a fenced JSON
 * block so `parseLlamaParseMarkdown` can extract it without a second LLM call.
 */
const LLAMAPARSE_JSON_SUFFIX =
  '\n\nReturn ONLY a fenced JSON block with no other text:\n```json\n[…]\n```';

/**
 * Extract ParsedTx[] from LlamaParse markdown output. Looks for a fenced
 * ```json … ``` block first, then falls back to a bare JSON array anywhere in
 * the text. Exported for unit testing without a live key.
 */
export function parseLlamaParseMarkdown(markdown: string): ParsedTx[] {
  let lastErr: Error | undefined;

  // Prefer an explicit fenced block.
  const fenced = markdown.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
  for (const match of fenced) {
    try {
      return parseModelJson(match[1]).map(toParsedTx);
    } catch (e) {
      lastErr = e as Error;
    }
  }

  // Fall back to the first valid bare JSON array in the text.
  const bareMatches = markdown.matchAll(/(\[[\s\S]*?\])/g);
  for (const match of bareMatches) {
    try {
      return parseModelJson(match[1]).map(toParsedTx);
    } catch (e) {
      lastErr = e as Error;
    }
  }

  // Then the outermost bare JSON object — some parse tiers wrap rows in
  // { transactions: [...] } without a fenced block.
  const firstBrace = markdown.indexOf('{');
  const lastBrace = markdown.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try {
      return parseModelJson(markdown.substring(firstBrace, lastBrace + 1)).map(toParsedTx);
    } catch (e) {
      lastErr = e as Error;
    }
  }

  throw new Error(`llamaparse: no JSON array found in markdown output. Last error: ${lastErr?.message ?? 'none'}`);
}

/** Read only an explicit provider-returned page count; never infer from bytes. */
export function extractProviderReportedPageCount(payload: unknown): number | undefined {
  const value = (payload ?? {}) as Record<string, unknown>;
  const nested = [value.usage_info, value.usage, value.job_metadata, value.metadata]
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object');
  const candidates = [
    value.pages_processed,
    value.pagesProcessed,
    value.page_count,
    value.num_pages,
    value.total_pages,
    ...nested.flatMap((entry) => [
      entry.pages_processed,
      entry.pagesProcessed,
      entry.page_count,
      entry.num_pages,
      entry.total_pages,
    ]),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 0) return candidate;
  }
  if (Array.isArray(value.pages)) return value.pages.length;
  return undefined;
}

/**
 * LlamaParse extraction call. The `model` string controls the parse tier:
 *   "fast"           — 1 credit/page  (basic OCR, good for clean text PDFs)
 *   "cost-effective" — 3 credits/page (page LLM, better table handling)
 *   "agentic"        — 10 credits/page (Gemini 2.5 Flash agent; handwriting candidate)
 *
 * The parsing_instruction guides the internal model to emit the JSON output
 * format we need. Poll interval is 2 s; hard timeout is 90 s (well inside the
 * Worker's cpu_ms=300_000 ceiling since poll time is I/O, not CPU).
 */
async function runLlamaParse(model: string, keyString: string, bytes: ArrayBuffer, chamber: string): Promise<ProviderResult> {
  const keys = keyString.split(',').map(k => k.trim()).filter(Boolean);
  if (!keys.length) throw new Error('llamaparse: no keys provided');
  let lastError: Error | null = null;

  for (const k of keys) {
    try {
      return await doRunLlamaParse(model, k, bytes, chamber);
    } catch (e) {
      const error = e as ProviderError;
      lastError = error;
      // A returned job id may already be billable. Never submit the same PDF
      // through another key after acceptance merely because polling or parsing
      // failed; doing so would hide duplicate spend.
      if (error.acceptedJob) throw error;
      // Pre-acceptance auth, quota, or upload failures may fail over.
      continue;
    }
  }
  throw lastError || new Error('llamaparse: all keys failed');
}

/** Canonical v1 form parameters for the three benchmarked public tiers. */
export function llamaParseModeParameters(model: string): Record<string, string> {
  if (model === 'fast') return { parse_mode: 'parse_page_without_llm' };
  if (model === 'cost-effective') {
    return { parse_mode: 'parse_page_with_llm', high_res_ocr: 'true' };
  }
  if (model === 'agentic') {
    return {
      parse_mode: 'parse_page_with_agent',
      model: 'gemini-2.5-flash',
      high_res_ocr: 'true',
    };
  }
  throw new Error(`llamaparse: unsupported benchmark mode ${model}`);
}

/**
 * Fetch the LlamaParse markdown result, retrying a couple of times on 404.
 * The job's SUCCESS status can be visible before the result object itself is
 * readable (eventual consistency); a couple of short backoff retries absorb
 * that window instead of failing an otherwise-successful parse. Injectable
 * `sleep`/`attempts` for tests. Exported for unit testing without a live key.
 */
export async function fetchLlamaParseResult(
  jobId: string,
  key: string,
  model: string,
  opts: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Response> {
  const attempts = opts.attempts ?? 3;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const url = `${LLAMAPARSE_BASE}/job/${jobId}/result/markdown`;
  const headers = { Authorization: `Bearer ${key}` };
  let res = await trackedFetch(
    url,
    { headers, signal: AbortSignal.timeout(120_000) },
    { service: 'ocr', operation: 'fetch-document-result', model },
  );
  for (let attempt = 1; attempt < attempts && res.status === 404; attempt++) {
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    await sleep(500 * attempt);
    res = await trackedFetch(
      url,
      { headers, signal: AbortSignal.timeout(120_000) },
      { service: 'ocr', operation: 'fetch-document-result-retry', model },
    );
  }
  return res;
}

async function doRunLlamaParse(model: string, key: string, bytes: ArrayBuffer, chamber: string): Promise<ProviderResult> {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'ptr.pdf');
  const promptToUse = chamber === 'executive' ? EXECUTIVE_SYSTEM_PROMPT : SYSTEM_PROMPT;
  form.append('parsing_instruction', promptToUse + LLAMAPARSE_JSON_SUFFIX);
  for (const [name, value] of Object.entries(llamaParseModeParameters(model))) {
    form.append(name, value);
  }

  // 1) Upload
  const up = await trackedFetch(`${LLAMAPARSE_BASE}/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  }, { service: 'ocr', operation: 'upload-document', model });
  if (!up.ok) throw new Error(`llamaparse upload ${up.status} ${await safeText(up)}`);
  const uploaded = (await up.json()) as { id?: string };
  if (!uploaded.id) throw new Error('llamaparse: upload returned no job id');

  let statusPageCount: number | undefined;
  try {
    // 2) Poll for completion (up to 90 s; each sleep is pure I/O wait).
    let succeeded = false;
    for (let i = 0; i < 45; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 2000));
      const st = await trackedFetch(`${LLAMAPARSE_BASE}/job/${uploaded.id}`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(120_000),
      }, { service: 'ocr', operation: 'poll-document-job', model });
      if (!st.ok) continue; // transient; keep polling
      const statusPayload = (await st.json()) as { status?: string };
      const { status } = statusPayload;
      statusPageCount = extractProviderReportedPageCount(statusPayload) ?? statusPageCount;
      if (status === 'SUCCESS') { succeeded = true; break; }
      if (status === 'ERROR' || status === 'CANCELLED') throw new Error(`llamaparse: job ${status ?? 'unknown'}`);
    }
    if (!succeeded) throw new Error('llamaparse: job timed out after 90s');

    // 3) Fetch markdown result. The job's SUCCESS status can be visible
    // before the result object is readable (eventual consistency); retry a
    // couple of times on 404 before failing an otherwise-successful parse.
    const res = await fetchLlamaParseResult(uploaded.id, key, model);
    if (!res.ok) throw new Error(`llamaparse result ${res.status} ${await safeText(res)}`);
    const resultPayload = (await res.json()) as { markdown?: string };
    const { markdown } = resultPayload;
    if (!markdown) throw new Error('llamaparse: empty markdown result');

    const pagesProcessed = extractProviderReportedPageCount(resultPayload) ?? statusPageCount;
    return {
      rows: parseLlamaParseMarkdown(markdown),
      usage: pagesProcessed == null ? undefined : { pagesProcessed },
      resolvedModel: model,
      providerRequestId: uploaded.id,
    };
  } catch (error) {
    throw Object.assign(error as Error, {
      acceptedJob: true,
      providerRequestId: uploaded.id,
      resolvedModel: model,
      ...(statusPageCount == null ? {} : { usage: { pagesProcessed: statusPageCount } }),
    } satisfies Partial<ProviderError>);
  }
}

/** Run one candidate over one document's bytes, timing it and trapping errors. */
export async function runCandidateOnDoc(
  env: Env,
  candidate: BakeoffCandidate,
  docId: string,
  bytes: ArrayBuffer,
  invocation?: CandidateInvocation,
): Promise<CandidateDocResult> {
  const { provider, model } = candidate;
  const base = { provider, model, docId };
  if (isRetiredDisclosureCandidate(candidate)) {
    return {
      ...base,
      ok: false,
      error: 'GPT-4o is retired for new disclosure extraction',
      latencyMs: 0,
      rowCount: 0,
      rowKeys: [],
      avgConfidence: 0,
      rows: [],
    };
  }
  const key = invocation ? invocation.apiKey : await keyFor(env, provider);
  if (!key) {
    const error = `${provider} API key not configured`;
    return {
      ...base,
      ok: false,
      error,
      failure: classifyProviderFailure(provider, model, error) ?? undefined,
      latencyMs: 0,
      rowCount: 0,
      rowKeys: [],
      avgConfidence: 0,
      rows: [],
    };
  }

  // Reuse prior rows for ordinary repeat reads, but never for benchmark paths
  // that need fresh provider latency/usage/cost measurements.
  if (!invocation?.skipCache) {
    try {
      const cachedRunResult = await env.DB?.prepare(
        `SELECT result_json FROM extraction_runs WHERE doc_id = ? AND provider = ? AND model = ? AND ok = 1 ORDER BY created_at DESC LIMIT 1`
      ).bind(docId, provider, model).first<{ result_json: string }>();

      if (cachedRunResult?.result_json) {
        const parsed = JSON.parse(cachedRunResult.result_json) as ParsedTx[];
        // result_json stores JSON.stringify(result.rows), not CandidateDocResult.
        if (Array.isArray(parsed)) {
          return {
            ...base,
            ok: true,
            latencyMs: 0,
            rowCount: parsed.length,
            rowKeys: parsed.map(arbitrationRowKey),
            avgConfidence: meanConfidence(parsed),
            rows: parsed,
            cached: true,
          };
        }
      }
    } catch {
      // extraction_runs may not exist before migration, or an old row may be
      // malformed. Either case falls through to the provider call.
    }
  }

  const started = Date.now();
  const occurredAt = new Date(started).toISOString();
  try {
    let rows: ParsedTx[];
    let usage: CandidateDocResult['usage'];
    let resolvedModel: string | undefined;
    let providerRequestId: string | undefined;
    let serviceTier: string | undefined;
    const chamber = docId.startsWith('E-') ? 'executive' : (docId.startsWith('S-') ? 'senate' : 'house');
    if (provider === 'gemini') {
      // docId is included so the metadata-grounded prompt can fill filing
      // facts (form type / filed year / page count / filer name) from D1.
      const result = await new VisionLlmExtractor(env, { model, apiKey: key }).extract({
        filing: { docId, docKind: 'scanned_pdf', chamber } as never,
        bytes,
      });
      rows = result.transactions;
      usage = result.usage;
      resolvedModel = result.modelVersion;
      providerRequestId = result.providerRequestId;
    } else if (provider === 'openai') {
      const openai = await runOpenAi(model, key, bytes, chamber);
      rows = openai.rows;
      usage = openai.usage;
      resolvedModel = openai.resolvedModel;
      providerRequestId = openai.providerRequestId;
      serviceTier = openai.serviceTier;
    } else if (provider === 'mistral') {
      const mistral = await runMistral(model, key, bytes);
      rows = mistral.rows;
      usage = mistral.usage;
      resolvedModel = mistral.resolvedModel;
      providerRequestId = mistral.providerRequestId;
    } else if (provider === 'xai') {
      const xai = await runXai(model, key, bytes, chamber);
      rows = xai.rows;
      usage = xai.usage;
      resolvedModel = xai.resolvedModel;
      providerRequestId = xai.providerRequestId;
    } else if (provider === 'llamaparse') {
      const lp = await runLlamaParse(model, key, bytes, chamber);
      rows = lp.rows;
      usage = lp.usage;
      resolvedModel = lp.resolvedModel;
      providerRequestId = lp.providerRequestId;
    } else if (provider === 'openrouter') {
      // docId included for the same metadata-grounded prompt lookup as above.
      const result = await new OpenRouterVisionExtractor(env, { model, apiKey: key }).extract({
        filing: { docId, docKind: 'scanned_pdf', chamber } as never,
        bytes,
      });
      rows = result.transactions;
      usage = result.usage;
      resolvedModel = result.modelVersion;
      providerRequestId = result.providerRequestId;
    } else {
      const anthropic = await runAnthropic(model, key, bytes, chamber);
      rows = anthropic.rows;
      usage = anthropic.usage;
      resolvedModel = anthropic.resolvedModel;
      providerRequestId = anthropic.providerRequestId;
    }
    
    if (usage) {
      // Telemetry is pushed via pushExtractionTelemetry in persistExtractionRun.
    }
    return {
      ...base,
      ok: true,
      latencyMs: Date.now() - started,
      rowCount: rows.length,
      rowKeys: rows.map(arbitrationRowKey),
      avgConfidence: meanConfidence(rows),
      rows,
      usage,
      resolvedModel,
      providerRequestId,
      occurredAt,
      serviceTier,
    };
  } catch (err) {
    const cast = err as ProviderError;
    const error = cast.message.slice(0, 300);
    
    if (cast.usage) {
      // Telemetry is pushed via pushExtractionTelemetry in persistExtractionRun.
    }
    
    return {
      ...base,
      ok: false,
      error,
      failure: classifyProviderFailure(provider, model, error) ?? undefined,
      latencyMs: Date.now() - started,
      rowCount: 0,
      rowKeys: [],
      avgConfidence: 0,
      rows: [],
      // Preserve token usage when the provider attached it to the error
      // (e.g. OpenAI parse failures — tokens were consumed but parsing failed).
      usage: cast.usage,
      resolvedModel: cast.resolvedModel,
      providerRequestId: cast.providerRequestId,
      occurredAt,
      serviceTier: cast.serviceTier,
    };
  }
}

/** Discriminates which caller produced an extraction_runs row. */
export type ExtractionRunKind = 'bakeoff' | 'batch' | 'production' | 'agreement' | 'benchmark';

/**
 * Persist one candidate's per-doc reading to `extraction_runs` (shape shared
 * with the /bake-off and /batch-status admin endpoints). Best-effort: swallows
 * write errors so a pre-migration DB (or a transient D1 hiccup) never breaks
 * the caller — the reading is nice-to-have, not a required side effect.
 */
export async function persistExtractionRun(
  env: Env,
  result: CandidateDocResult,
  kind: ExtractionRunKind,
  batchId: string | null = null,
): Promise<void> {
  // Durable Queue hand-off; failures are fail-soft inside the telemetry module.
  await pushExtractionTelemetry(env, result, kind);

  try {
    await run(
      env.DB,
      `INSERT INTO extraction_runs
         (id, batch_id, doc_id, provider, model, kind, ok, error, row_count, latency_ms, avg_confidence, result_json, usage_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuid(),
        batchId,
        result.docId,
        result.provider,
        result.model,
        kind,
        result.ok ? 1 : 0,
        result.error ?? null,
        result.rowCount,
        result.latencyMs,
        result.avgConfidence,
        JSON.stringify(result.rows ?? []),
        JSON.stringify(result.usage ?? null),
        new Date().toISOString(),
      ],
    );
  } catch {
    // Table may not exist yet (pre-migration) — keep callers read/write-path-safe.
  }
}

/** Mean per-row extractor confidence over a model's extracted rows, 0 when empty. */
export function meanConfidence(rows: ParsedTx[]): number {
  if (!rows.length) return 0;
  const sum = rows.reduce((s, r) => s + (typeof r.confidence === 'number' ? r.confidence : 0), 0);
  return Math.round((sum / rows.length) * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Pure aggregation (unit-tested) — no I/O.
// ---------------------------------------------------------------------------

/**
 * For each document, the "consensus" row set = row keys found by a strict
 * MAJORITY of the models that successfully ran that doc. Each model's agreement
 * is the mean fraction of that consensus it recovered — a recall-vs-peers proxy
 * that needs no hand-labelled answer key.
 */
export function computeConsensusAgreement(results: CandidateDocResult[]): Map<string, number> {
  const byDoc = new Map<string, CandidateDocResult[]>();
  for (const r of results) {
    const documentResults = byDoc.get(r.docId) ?? [];
    documentResults.push(r);
    byDoc.set(r.docId, documentResults);
  }

  // Per model: accumulate recovered-fraction across docs that had a consensus.
  const sum = new Map<string, number>();
  const count = new Map<string, number>();

  for (const docResults of byDoc.values()) {
    const ok = docResults.filter((r) => r.ok);
    if (ok.length < 2) continue; // need ≥2 models to form a consensus

    // Tally how many models found each key; consensus = found by > half.
    const keyVotes = new Map<string, number>();
    for (const r of ok) {
      for (const k of new Set(r.rowKeys)) keyVotes.set(k, (keyVotes.get(k) ?? 0) + 1);
    }
    const majority = Math.floor(ok.length / 2) + 1;
    const consensus = new Set([...keyVotes].filter(([, v]) => v >= majority).map(([k]) => k));
    if (consensus.size === 0) continue;

    for (const r of ok) {
      const have = new Set(r.rowKeys);
      let hit = 0;
      for (const k of consensus) if (have.has(k)) hit++;
      const m = label(r);
      sum.set(m, (sum.get(m) ?? 0) + hit / consensus.size);
      count.set(m, (count.get(m) ?? 0) + 1);
    }
  }

  const out = new Map<string, number>();
  for (const [m, s] of sum) out.set(m, s / (count.get(m) || 1));
  return out;
}

/** Roll per-doc results up into one summary row per model. */
export function summarizeModels(
  candidates: BakeoffCandidate[],
  results: CandidateDocResult[],
): ModelSummary[] {
  const agreement = computeConsensusAgreement(results);
  return candidates.map((c) => {
    const mine = results.filter((r) => r.provider === c.provider && r.model === c.model);
    const ok = mine.filter((r) => r.ok);
    const totalRows = ok.reduce((s, r) => s + r.rowCount, 0);
    const latencySum = mine.reduce((s, r) => s + r.latencyMs, 0);
    return {
      provider: c.provider,
      model: c.model,
      label: label(c),
      docsAttempted: mine.length,
      docsOk: ok.length,
      failures: mine.length - ok.length,
      totalRows,
      avgRowsPerOkDoc: ok.length ? round2(totalRows / ok.length) : 0,
      avgLatencyMs: mine.length ? Math.round(latencySum / mine.length) : 0,
      consensusAgreement: round2(agreement.get(label(c)) ?? 0),
    };
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
