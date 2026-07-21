/**
 * src/extraction/batchExtract.ts
 *
 * Async **batch** extraction adapters for backlog reprocessing — ~50% cheaper
 * than the synchronous path, at the cost of async turnaround (minutes to 24h).
 * Used only for non-time-sensitive bulk work (e.g. draining the review queue),
 * never the live feed.
 *
 * Four providers, chosen for Worker-friendliness + PDF support in batch:
 *   - anthropic: Message Batches — inline request array, native base64 `document`
 *     block, no file pre-upload. The cleanest fit; typically <1h.
 *   - openai:    /v1/batches — requires a JSONL file upload first; GPT-5.6 lines
 *     use `/v1/responses` with uploaded PDF ids and structured output. The old
 *     Chat Completions shape remains readable for historical GPT-4o jobs.
 *   - mistral:   /v1/batch/jobs over /v1/ocr — JSONL upload; cheapest per page.
 *   - xAI:       /v1/batches — uploaded PDF file ids referenced by Responses
 *     requests, with exact provider spend and attachment-search usage retained.
 *
 * Each provider exposes submit() (kick off, return the provider's batch id) and
 * poll() (status + decoded per-doc rows when finished). The per-line result
 * decoders are pure and unit-tested; the network plumbing mirrors bakeoff.ts.
 */

import type { Env, ParsedTx } from '../shared/types.ts';
import {
  SYSTEM_PROMPT,
  EXECUTIVE_SYSTEM_PROMPT,
  parseModelJson,
  parseTruncationAwareJson,
  markSalvaged,
  toParsedTx,
  arrayBufferToBase64,
  validatePdfForAnthropic,
} from './visionLlm.ts';
import {
  MISTRAL_ANNOTATION_SCHEMA,
  extractResponsesText,
  extractXaiResponseText,
  isRetiredDisclosureCandidate,
  openAiDisclosureReasoningEffort,
  parseMistralOcrResponse,
} from './bakeoff.ts';
import { resolveSecret } from '../secrets/infisical.ts';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';

export type BatchProvider = 'anthropic' | 'openai' | 'mistral' | 'xai';
export type BatchChamber = 'house' | 'senate' | 'executive';

/** A document to include in a batch: a stable id (its docId) + the raw PDF bytes. */
export interface BatchDoc {
  docId: string;
  chamber: BatchChamber;
  bytes: ArrayBuffer;
}

/** One document's decoded result inside a finished batch. */
export interface BatchDocResult {
  docId: string;
  ok: boolean;
  error?: string;
  rows: ParsedTx[];
  /** Provider-reported billable units. Unknown fields remain absent. */
  usage?: BatchUsage;
  /** Concrete model/version returned with this result, when available. */
  resolvedModel?: string;
}

export interface BatchUsage {
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  pagesProcessed?: number;
  /** xAI's exact provider-reported spend in 1e-10 USD ticks. */
  costInUsdTicks?: number;
  /** xAI server-side attachment-search calls used for an input file. */
  attachmentSearchCalls?: number;
}

/** Poll outcome: still running, or finished (with per-doc results). */
export interface BatchPoll {
  done: boolean;
  failed: boolean;
  status: string;
  results: BatchDocResult[];
  /** Provider-reported usage for the whole batch, when complete and valid. */
  aggregateUsage?: BatchUsage;
  /** Safe, bounded provider-level terminal errors reported on the batch object. */
  providerErrors?: { count: number; summaries: string[] };
  /** Provider-authored batch creation time, when the API exposes one. */
  submittedAt?: string;
  /** Provider-authored terminal transition time, when the API exposes one. */
  terminalAt?: string;
}

export interface BatchTerminalPayloadContext {
  aggregateUsage?: BatchUsage;
  /** Safe, bounded provider-level errors from the Batch object. */
  providerErrors?: BatchPoll['providerErrors'];
  /** Successfully decoded result records observed before the malformed record. */
  returnedDocs?: number;
  /**
   * Bounded identities for settlement-time membership checks only. A null
   * entry means the provider returned a non-string or excessively long id.
   * These values must never be echoed in an operator-facing error summary.
   */
  observedDocIds?: Array<string | null>;
  /** More decoded identities existed than can safely be retained in context. */
  observedDocIdsTruncated?: true;
  submittedAt?: string;
  terminalAt?: string;
}

export class BatchTerminalPayloadError extends Error {
  constructor(
    readonly code: 'malformed_result_jsonl',
    readonly providerStatus = 'unknown',
    readonly context: BatchTerminalPayloadContext = {},
  ) {
    super('batch provider returned an invalid terminal payload');
    this.name = 'BatchTerminalPayloadError';
  }
}

// /batch-submit accepts at most 200 documents. Retain enough identities for
// exact normal-route settlement while bounding corrupt or adversarial files.
const MAX_TERMINAL_CONTEXT_DOC_IDS = 200;
const MAX_TERMINAL_CONTEXT_DOC_ID_LENGTH = 1_024;

function safeTerminalContextDocId(value: unknown): string | null {
  return typeof value === 'string' && value.length <= MAX_TERMINAL_CONTEXT_DOC_ID_LENGTH
    ? value
    : null;
}

function unixSecondsToIso(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return undefined;
  try {
    const iso = new Date(value * 1_000).toISOString();
    return Number.isFinite(Date.parse(iso)) ? iso : undefined;
  } catch {
    return undefined;
  }
}

function rfc3339ToIso(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[Tt](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match) return undefined;
  const calendarDay = `${match[1]}-${match[2]}-${match[3]}`;
  const calendarTimestamp = Date.parse(`${calendarDay}T00:00:00.000Z`);
  if (!Number.isFinite(calendarTimestamp)
    || new Date(calendarTimestamp).toISOString().slice(0, 10) !== calendarDay) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  try {
    return new Date(timestamp).toISOString();
  } catch {
    return undefined;
  }
}

/** Parse OpenAI's documented Unix-second batch lifecycle fields. */
export function parseOpenAiBatchTimestamps(value: unknown): Pick<BatchPoll, 'submittedAt' | 'terminalAt'> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return {};
  const batch = value as Record<string, unknown>;
  const status = typeof batch.status === 'string' ? batch.status.toLowerCase() : '';
  const terminalFieldByStatus: Record<string, string> = {
    completed: 'completed_at',
    failed: 'failed_at',
    expired: 'expired_at',
    cancelled: 'cancelled_at',
  };
  const preferredTerminalField = terminalFieldByStatus[status];
  const terminalFields = preferredTerminalField
    ? [
        preferredTerminalField,
        ...['completed_at', 'failed_at', 'expired_at', 'cancelled_at']
          .filter((field) => field !== preferredTerminalField),
      ]
    : [];
  const submittedAt = unixSecondsToIso(batch.created_at);
  const terminalAt = terminalFields
    .map((field) => unixSecondsToIso(batch[field]))
    .find((timestamp) => timestamp != null);
  return {
    ...(submittedAt ? { submittedAt } : {}),
    ...(terminalAt ? { terminalAt } : {}),
  };
}

export function normalizeBatchChamber(
  chamber: string | null | undefined,
  docId: string,
): BatchChamber {
  const normalized = chamber?.trim().toLowerCase();
  if (normalized === 'house' || normalized === 'senate' || normalized === 'executive') {
    return normalized;
  }
  if (docId.startsWith('E-')) return 'executive';
  if (docId.startsWith('S-')) return 'senate';
  return 'house';
}

export function batchPrompt(
  chamber: BatchChamber,
  responseShape: 'object' | 'array',
): string {
  const systemPrompt = chamber === 'executive' ? EXECUTIVE_SYSTEM_PROMPT : SYSTEM_PROMPT;
  return responseShape === 'object'
    ? `${systemPrompt}\nReturn a JSON object {"transactions": [...]} .`
    : `${systemPrompt}\nReturn ONLY the JSON array.`;
}

function normalizeBatchUsage(values: BatchUsage): BatchUsage | undefined {
  const usage: BatchUsage = {};
  for (const key of [
    'promptTokens',
    'completionTokens',
    'cachedTokens',
    'pagesProcessed',
    'costInUsdTicks',
    'attachmentSearchCalls',
  ] as const) {
    const value = values[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) usage[key] = value;
  }
  return Object.keys(usage).length ? usage : undefined;
}

function nonNegativeSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/** Parse OpenAI's optional batch-level token usage without inventing partial totals. */
export function parseOpenAiBatchUsage(value: unknown): BatchUsage | undefined {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const promptTokens = nonNegativeSafeInteger(raw.input_tokens);
  const completionTokens = nonNegativeSafeInteger(raw.output_tokens);
  if (promptTokens == null || completionTokens == null
    || !Number.isSafeInteger(promptTokens + completionTokens)) return undefined;

  let cachedTokens: number | undefined;
  if (raw.input_tokens_details != null) {
    if (typeof raw.input_tokens_details !== 'object' || Array.isArray(raw.input_tokens_details)) {
      return undefined;
    }
    const details = raw.input_tokens_details as Record<string, unknown>;
    if (details.cached_tokens != null) {
      cachedTokens = nonNegativeSafeInteger(details.cached_tokens);
      if (cachedTokens == null || cachedTokens > promptTokens) return undefined;
    }
  }

  return {
    promptTokens,
    completionTokens,
    ...(cachedTokens == null ? {} : { cachedTokens }),
  };
}

function boundedErrorText(value: unknown, maxLength = 240): string {
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, maxLength);
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return 'provider error';
  const raw = value as Record<string, unknown>;
  const parts = [raw.code, raw.type, raw.message]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .map((part) => part.trim());
  return (parts.length ? parts.join(': ') : 'provider error').slice(0, maxLength);
}

function safeProviderErrorCode(value: unknown): string {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return 'provider_error';
  const raw = value as Record<string, unknown>;
  const candidate = [raw.code, raw.type]
    .find((part): part is string => typeof part === 'string' && part.trim().length > 0);
  if (!candidate) return 'provider_error';
  const normalized = candidate.trim().slice(0, 64);
  return /^[A-Za-z0-9._-]+$/.test(normalized) ? normalized : 'provider_error';
}

/** Count OpenAI Batch-object inline errors without retaining arbitrary messages. */
export function parseOpenAiBatchErrors(value: unknown): BatchPoll['providerErrors'] {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const data = (value as Record<string, unknown>).data;
  if (!Array.isArray(data) || data.length === 0) return undefined;
  return {
    count: data.length,
    summaries: data.slice(0, 20).map(safeProviderErrorCode),
  };
}

async function keyFor(env: Env, provider: BatchProvider): Promise<string> {
  const key =
    provider === 'anthropic' ? (await resolveSecret(env, 'ANTHROPIC_API_KEY')).value
    : provider === 'openai' ? (await resolveSecret(env, 'OPENAI_API_KEY')).value
    : provider === 'xai' ? (await resolveSecret(env, 'XAI_API_KEY')).value
    : (await resolveSecret(env, 'MISTRAL_API_KEY')).value;
  if (!key) throw new Error(`${provider} API key not configured`);
  return key;
}

/** Upload one PDF to a provider's Files API; returns the file id to reference. */
async function uploadPdf(
  url: string,
  key: string,
  bytes: ArrayBuffer,
  purpose: string,
  options: { expiresAfterSeconds?: number } = {},
): Promise<string> {
  const form = new FormData();
  form.append('purpose', purpose);
  if (options.expiresAfterSeconds != null) {
    form.append('expires_after', String(options.expiresAfterSeconds));
  }
  form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'ptr.pdf');
  const res = await trackedFetch(
    url,
    { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form },
    { service: 'llm-batch', operation: 'upload-document' },
  );
  if (!res.ok) throw new Error(`pdf upload ${res.status} ${await safeText(res)}`);
  const j = (await res.json()) as { id?: string };
  if (!j.id) throw new Error('pdf upload: no id');
  return j.id;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 400);
  } catch {
    return '';
  }
}

async function pMap<T, U>(items: T[], limit: number, fn: (item: T) => Promise<U>): Promise<U[]> {
  const results: U[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (i < items.length) {
      const index = i++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Anthropic Message Batches — inline array, no upload.
//
// Unlike the sync paths (bakeoff.ts runAnthropic, anthropicVision.ts), there
// is no in-band per-item RETRY once a batch is submitted (the resave-repair
// retry added for the 2026-07-15 invalid-PDF regression — see
// validatePdfForAnthropic/resavePdfForAnthropic in visionLlm.ts — is
// sync-path-only): a batch item that still 400s on an invalid PDF after
// pre-validation surfaces as a per-doc failure in decodeAnthropicLine() below
// and is left for a later sync pass (which DOES have the repair retry) to
// resolve. Docs that DO pass pre-validation are sent as-is — their ORIGINAL
// bytes, never a pdf-lib resave — mirroring the sync path's decision that
// resaved bytes are a repair fallback only, not the default (see
// validatePdfForAnthropic's doc comment for the receipted regression this
// avoids).
//
// What IS pre-validated: each doc's PDF bytes are checked with
// validatePdfForAnthropic (pdf-lib load-only, fail-fast, no resave) BEFORE
// the batch request is built. A doc that fails this check is never sent to
// Anthropic — one malformed PDF in a 200-doc inline array would otherwise
// waste every other doc's provider call if the whole batch request 400s, and
// even if Anthropic accepts the array and only that one line errors, the
// error class is a document property established locally already, so there
// is no reason to spend the round trip. The excluded docId still needs a
// terminal BatchDocResult, though: batch_jobs.doc_ids accounting (set by the
// caller from the full input `docs` list, not what actually reaches the
// provider) expects every submitted docId to resolve to a result. Since
// submitBatch's return type is a single opaque provider-batch-id string
// threaded straight through to pollBatch by callers (admin/routes.ts,
// batchCron.ts) with no other channel between submit and poll, pre-validation
// failures are carried inside that string (see encodePrevalidatedBatchId /
// decodePrevalidatedBatchId) and merged into pollAnthropic's results the same
// way a real per-item provider error would appear. When EVERY doc in a batch
// fails pre-validation, submitAnthropic makes zero provider calls and returns
// an all-synthetic id that pollAnthropic resolves without ever contacting
// Anthropic.
// ---------------------------------------------------------------------------

/** One doc excluded from the provider request by local pre-validation. */
interface AnthropicPrevalidationFailure {
  docId: string;
  /** Captured from the thrown Error so it is always exactly what
   *  validatePdfForAnthropic produces, never a hand-duplicated copy that
   *  could drift out of sync with it. */
  error: string;
}

/** Marker prefix identifying a providerBatchId that carries pre-validation
 *  failures. Anthropic's own batch ids (`msgbatch_...`) never start with
 *  this, so a plain provider id — including every historical `batch_jobs`
 *  row persisted before this change — is left completely unaffected. */
const PREVALIDATED_BATCH_ID_MARKER = 'ct-batch-prevalidated-v1:';

function encodePrevalidatedBatchId(
  realBatchId: string | null,
  excluded: AnthropicPrevalidationFailure[],
): string {
  return PREVALIDATED_BATCH_ID_MARKER + JSON.stringify({ realBatchId, excluded });
}

function decodePrevalidatedBatchId(
  providerBatchId: string,
): { realBatchId: string | null; excluded: AnthropicPrevalidationFailure[] } | null {
  if (!providerBatchId.startsWith(PREVALIDATED_BATCH_ID_MARKER)) return null;
  try {
    const parsed = JSON.parse(providerBatchId.slice(PREVALIDATED_BATCH_ID_MARKER.length)) as {
      realBatchId?: unknown;
      excluded?: unknown;
    };
    const excluded = Array.isArray(parsed.excluded)
      ? parsed.excluded.flatMap((entry): AnthropicPrevalidationFailure[] => {
          if (entry == null || typeof entry !== 'object') return [];
          const e = entry as { docId?: unknown; error?: unknown };
          return typeof e.docId === 'string' && e.docId && typeof e.error === 'string' && e.error
            ? [{ docId: e.docId, error: e.error }]
            : [];
        })
      : [];
    const realBatchId = typeof parsed.realBatchId === 'string' && parsed.realBatchId
      ? parsed.realBatchId
      : null;
    return { realBatchId, excluded };
  } catch {
    return null;
  }
}

function anthropicRequest(doc: BatchDoc, model: string): unknown {
  return {
    custom_id: doc.docId,
    params: {
      model,
      max_tokens: 8000,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: arrayBufferToBase64(doc.bytes) } },
            { type: 'text', text: batchPrompt(doc.chamber, 'array') },
          ],
        },
      ],
    },
  };
}

async function submitAnthropic(env: Env, model: string, docs: BatchDoc[]): Promise<string> {
  // Pre-validate every doc's bytes before spending a provider call — see the
  // section comment above for why this lives here rather than relying on a
  // per-item provider 400.
  const validDocs: BatchDoc[] = [];
  const excluded: AnthropicPrevalidationFailure[] = [];
  for (const doc of docs) {
    try {
      await validatePdfForAnthropic(doc.bytes);
      validDocs.push(doc);
    } catch (err) {
      excluded.push({ docId: doc.docId, error: (err as Error).message });
    }
  }

  if (validDocs.length === 0) {
    // Every doc failed pre-validation: make zero provider calls. pollAnthropic
    // resolves this id straight from the encoded failures, never contacting
    // Anthropic at all.
    return encodePrevalidatedBatchId(null, excluded);
  }

  const key = await keyFor(env, 'anthropic');
  const res = await trackedFetch('https://api.anthropic.com/v1/messages/batches', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ requests: validDocs.map((d) => anthropicRequest(d, model)) }),
  }, { service: 'llm-batch', operation: 'create-batch', model });
  if (!res.ok) throw new Error(`anthropic batch create ${res.status} ${await safeText(res)}`);
  const j = (await res.json()) as { id?: string };
  if (!j.id) throw new Error('anthropic batch: no id');
  return excluded.length > 0 ? encodePrevalidatedBatchId(j.id, excluded) : j.id;
}

/**
 * Decode one Anthropic batch result line to rows. Exported for tests. Unlike
 * the sync path, a batch request can't be retried mid-flight — when the
 * provider reports `stop_reason: 'max_tokens'` (output truncated) and the
 * text fails to parse whole, bounded salvage recovers the complete leading
 * transaction rows instead of failing the whole read (see
 * `parseTruncationAwareJson` in visionLlm.ts).
 */
export function decodeAnthropicLine(line: unknown): BatchDocResult {
  const l = line as {
    custom_id?: string;
    result?: {
      type?: string;
      message?: {
        content?: Array<{ type: string; text?: string }>;
        stop_reason?: string | null;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
        };
      };
      error?: unknown;
    };
  };
  const docId = l.custom_id ?? '';
  const usage = normalizeBatchUsage({
    promptTokens: l.result?.message?.usage?.input_tokens,
    completionTokens: l.result?.message?.usage?.output_tokens,
    cachedTokens: l.result?.message?.usage?.cache_read_input_tokens,
  });
  if (l.result?.type !== 'succeeded' || !l.result.message) {
    return { docId, ok: false, error: JSON.stringify(l.result?.error ?? l.result?.type ?? 'failed').slice(0, 300), rows: [], usage };
  }
  try {
    const text = (l.result.message.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('').trim();
    const { rows: modelRows, salvaged } = parseTruncationAwareJson(text, l.result.message.stop_reason === 'max_tokens');
    const rows = modelRows.map(toParsedTx).map((tx: ParsedTx) => (salvaged ? markSalvaged(tx) : tx));
    return { docId, ok: true, rows, usage };
  } catch (err) {
    return { docId, ok: false, error: (err as Error).message.slice(0, 300), rows: [], usage };
  }
}

/** Build the terminal BatchDocResult for a doc excluded by pre-validation —
 *  same shape decodeAnthropicLine would produce for a real per-item provider
 *  error, so downstream persistence (extraction_runs, providerFailure.ts
 *  classification, review-queue routing) treats it identically. */
function prevalidationFailureResult(entry: AnthropicPrevalidationFailure): BatchDocResult {
  return { docId: entry.docId, ok: false, error: entry.error, rows: [] };
}

async function pollAnthropic(env: Env, providerBatchId: string): Promise<BatchPoll> {
  const prevalidated = decodePrevalidatedBatchId(providerBatchId);
  const excludedResults = (prevalidated?.excluded ?? []).map(prevalidationFailureResult);

  if (prevalidated && prevalidated.realBatchId === null) {
    // Every doc in this batch failed pre-validation at submit time; nothing
    // was ever sent to Anthropic, so there is nothing to poll for.
    return { done: true, failed: false, status: 'ended', results: excludedResults };
  }

  const realBatchId = prevalidated?.realBatchId ?? providerBatchId;
  const key = await keyFor(env, 'anthropic');
  const headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  const res = await trackedFetch(
    `https://api.anthropic.com/v1/messages/batches/${encodeURIComponent(realBatchId)}`,
    { headers },
    { service: 'llm-batch', operation: 'poll-batch' },
  );
  if (!res.ok) throw new Error(`anthropic batch get ${res.status} ${await safeText(res)}`);
  const j = (await res.json()) as {
    processing_status?: string;
    results_url?: string | null;
    created_at?: string | null;
    ended_at?: string | null;
  };
  const status = j.processing_status ?? 'unknown';
  const submittedAt = rfc3339ToIso(j.created_at);
  const terminalAt = status === 'ended' ? rfc3339ToIso(j.ended_at) : undefined;
  const timestamps = {
    ...(submittedAt ? { submittedAt } : {}),
    ...(terminalAt ? { terminalAt } : {}),
  };
  if (status !== 'ended' || !j.results_url) {
    return { done: false, failed: false, status, results: [], ...timestamps };
  }
  const rj = await trackedFetch(
    j.results_url,
    { headers },
    { service: 'llm-batch', operation: 'fetch-batch-results' },
  );
  if (!rj.ok) throw new Error(`anthropic batch results ${rj.status}`);
  const results = parseJsonl(await rj.text()).map(decodeAnthropicLine);
  return { done: true, failed: false, status: 'ended', results: [...results, ...excludedResults], ...timestamps };
}

// ---------------------------------------------------------------------------
// OpenAI /v1/batches — upload one PDF per request, then a JSONL request file.
// ---------------------------------------------------------------------------

// OpenAI Batch does NOT accept inline base64 in a JSONL line — each PDF must be
// uploaded to the Files API first and referenced by file_id (inline base64 is
// sync-only). Responses lines use `input_file.file_id`; the legacy Chat
// Completions shape uses `{type:'file', file:{file_id}}`.
function openaiLine(doc: BatchDoc, fileId: string, model: string): string {
  const useResponses = model.startsWith('gpt-5.6');
  return JSON.stringify({
    custom_id: doc.docId,
    method: 'POST',
    url: useResponses ? '/v1/responses' : '/v1/chat/completions',
    body: useResponses
      ? {
          model,
          service_tier: 'default',
          reasoning: { effort: openAiDisclosureReasoningEffort(model) },
          max_output_tokens: 8_000,
          input: [{
            role: 'user',
            content: [
              { type: 'input_file', file_id: fileId, detail: 'high' },
              { type: 'input_text', text: batchPrompt(doc.chamber, 'object') },
            ],
          }],
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
            { role: 'user', content: [
              { type: 'text', text: batchPrompt(doc.chamber, 'object') },
              { type: 'file', file: { file_id: fileId } },
            ] },
          ],
        },
  });
}

async function uploadJsonl(url: string, key: string, jsonl: string, extra: Record<string, string>): Promise<string> {
  const form = new FormData();
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  form.append('file', new Blob([jsonl], { type: 'application/jsonl' }), 'batch.jsonl');
  const res = await trackedFetch(
    url,
    { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form },
    { service: 'llm-batch', operation: 'upload-batch-input' },
  );
  if (!res.ok) throw new Error(`file upload ${res.status} ${await safeText(res)}`);
  const j = (await res.json()) as { id?: string };
  if (!j.id) throw new Error('file upload: no id');
  return j.id;
}

async function submitOpenAi(env: Env, model: string, docs: BatchDoc[]): Promise<string> {
  const key = await keyFor(env, 'openai');
  const endpoint = model.startsWith('gpt-5.6') ? '/v1/responses' : '/v1/chat/completions';
  // 1) upload each PDF to the Files API (purpose=user_data) → file_id.
  // Concurrency limit of 25 provides 5x throughput while leaving safe headroom
  // under Cloudflare Workers' hard ceiling of 50 concurrent subrequests per invocation
  // (for batch creation and JSONL input uploads).
  const lines: string[] = await pMap(docs, 25, async (d) => {
    const fileId = await uploadPdf('https://api.openai.com/v1/files', key, d.bytes, 'user_data');
    return openaiLine(d, fileId, model);
  });
  // 2) upload the JSONL of requests (purpose=batch) → input file.
  const fileId = await uploadJsonl('https://api.openai.com/v1/files', key, lines.join('\n'), { purpose: 'batch' });
  const res = await trackedFetch('https://api.openai.com/v1/batches', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ input_file_id: fileId, endpoint, completion_window: '24h' }),
  }, { service: 'llm-batch', operation: 'create-batch', model });
  if (!res.ok) throw new Error(`openai batch create ${res.status} ${await safeText(res)}`);
  const j = (await res.json()) as { id?: string };
  if (!j.id) throw new Error('openai batch: no id');
  return j.id;
}

/** Decode one OpenAI batch output line to rows. Exported for tests. */
export function decodeOpenAiLine(line: unknown): BatchDocResult {
  const l = line as {
    custom_id?: string;
    response?: {
      status_code?: number;
      body?: {
        model?: string;
        status?: unknown;
        incomplete_details?: { reason?: unknown } | null;
        error?: unknown;
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        output_text?: unknown;
        output?: Array<{ content?: Array<{ text?: string; refusal?: string }> }>;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          input_tokens_details?: { cached_tokens?: number };
          prompt_tokens?: number;
          completion_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
        };
      };
    };
    error?: unknown;
  };
  const docId = l.custom_id ?? '';
  const body = l.response?.body;
  const rawResponseStatus = body?.status;
  const responseStatus = typeof rawResponseStatus === 'string' ? rawResponseStatus : undefined;
  const responseStatusInvalid = rawResponseStatus != null && responseStatus == null;
  
  let isTruncated = false;
  let responseLifecycleError: string | undefined;
  if (responseStatusInvalid) {
    responseLifecycleError = 'invalid response lifecycle status';
  } else if (responseStatus === 'incomplete' && body?.incomplete_details?.reason === 'max_output_tokens') {
    isTruncated = true;
  } else if (responseStatus && responseStatus !== 'completed') {
    responseLifecycleError = `response ${responseStatus}${typeof body?.incomplete_details?.reason === 'string'
      ? `: ${body.incomplete_details.reason}`
      : ''}`;
  } else if (!responseStatus && body?.choices?.[0]?.finish_reason === 'length') {
    isTruncated = true;
  }

  const refusal = (body?.output ?? [])
    .flatMap((item) => item.content ?? [])
    .map((item) => item.refusal?.trim())
    .find((value): value is string => Boolean(value));
  let content = body?.choices?.[0]?.message?.content;
  if (!content && body) {
    try {
      content = extractResponsesText(body, 'openai');
    } catch {
      content = undefined;
    }
  }
  const resolvedModel = l.response?.body?.model;
  const rawStatusCode = l.response?.status_code;
  const statusCode = typeof rawStatusCode === 'number' && Number.isInteger(rawStatusCode)
    && rawStatusCode >= 100 && rawStatusCode <= 599
    ? rawStatusCode
    : undefined;
  const statusCodeInvalid = rawStatusCode != null && statusCode == null;
  const responseError = l.response?.body?.error;
  const usage = normalizeBatchUsage({
    promptTokens: body?.usage?.input_tokens ?? body?.usage?.prompt_tokens,
    completionTokens: body?.usage?.output_tokens ?? body?.usage?.completion_tokens,
    cachedTokens: body?.usage?.input_tokens_details?.cached_tokens
      ?? body?.usage?.prompt_tokens_details?.cached_tokens,
  });
  if (l.error || responseError || responseLifecycleError || refusal || statusCodeInvalid
    || (statusCode != null && (statusCode < 200 || statusCode >= 300)) || !content) {
    const statusPrefix = statusCodeInvalid
      ? 'invalid response status'
      : statusCode == null || (statusCode >= 200 && statusCode < 300) ? '' : `HTTP ${statusCode}`;
    const detail = l.error ?? responseError ?? responseLifecycleError
      ?? (refusal ? `refusal: ${refusal}` : undefined)
      ?? (!content ? 'no content' : 'provider error');
    const error = [statusPrefix, boundedErrorText(detail)].filter(Boolean).join(': ').slice(0, 300);
    return { docId, ok: false, error, rows: [], usage, resolvedModel };
  }
  try {
    const { rows: modelRows, salvaged } = parseTruncationAwareJson(content, isTruncated);
    return { docId, ok: true, rows: modelRows.map(toParsedTx).map((tx: ParsedTx) => (salvaged ? markSalvaged(tx) : tx)), usage, resolvedModel };
  } catch (err) {
    return { docId, ok: false, error: (err as Error).message.slice(0, 300), rows: [], usage, resolvedModel };
  }
}

async function fetchOpenAiBatchResults(key: string, outputFileId: string): Promise<BatchDocResult[]> {
  const response = await trackedFetch(
    `https://api.openai.com/v1/files/${encodeURIComponent(outputFileId)}/content`,
    { headers: { authorization: `Bearer ${key}` } },
    { service: 'llm-batch', operation: 'fetch-batch-results' },
  );
  if (!response.ok) throw new Error(`openai batch results ${response.status}`);
  const lines = (await response.text()).split(/\r?\n/);
  const decoded: BatchDocResult[] = [];
  const observedDocIds: Array<string | null> = [];
  let observedDocIdsTruncated = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new BatchTerminalPayloadError('malformed_result_jsonl', 'unknown', {
        returnedDocs: decoded.length,
        observedDocIds,
        ...(observedDocIdsTruncated ? { observedDocIdsTruncated: true } : {}),
      });
    }
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new BatchTerminalPayloadError('malformed_result_jsonl', 'unknown', {
        returnedDocs: decoded.length,
        observedDocIds,
        ...(observedDocIdsTruncated ? { observedDocIdsTruncated: true } : {}),
      });
    }
    decoded.push(decodeOpenAiLine(parsed));
    if (observedDocIds.length < MAX_TERMINAL_CONTEXT_DOC_IDS) {
      observedDocIds.push(safeTerminalContextDocId((parsed as Record<string, unknown>).custom_id));
    } else {
      observedDocIdsTruncated = true;
    }
  }
  return decoded;
}

async function pollOpenAi(env: Env, batchId: string): Promise<BatchPoll> {
  const key = await keyFor(env, 'openai');
  const res = await trackedFetch(
    `https://api.openai.com/v1/batches/${encodeURIComponent(batchId)}`,
    { headers: { authorization: `Bearer ${key}` } },
    { service: 'llm-batch', operation: 'poll-batch' },
  );
  if (!res.ok) throw new Error(`openai batch get ${res.status} ${await safeText(res)}`);
  const j = (await res.json()) as {
    status?: string;
    output_file_id?: string | null;
    error_file_id?: string | null;
    created_at?: number | null;
    completed_at?: number | null;
    failed_at?: number | null;
    expired_at?: number | null;
    cancelled_at?: number | null;
    usage?: unknown;
    errors?: unknown;
  };
  const status = typeof j.status === 'string' ? j.status.toLowerCase() : 'unknown';
  const timestamps = parseOpenAiBatchTimestamps(j);
  const aggregateUsage = parseOpenAiBatchUsage(j.usage);
  const providerErrors = parseOpenAiBatchErrors(j.errors);
  const terminal = ['completed', 'failed', 'expired', 'cancelled'].includes(status);
  if (!terminal) {
    return { done: false, failed: false, status, results: [], ...timestamps };
  }

  // A completed batch may legitimately contain only errored requests, or no
  // result files at all. Fetch both files when present and keep output first so
  // replay identity is independent of network completion order.
  const outputFileId = typeof j.output_file_id === 'string' ? j.output_file_id.trim() : '';
  const errorFileId = typeof j.error_file_id === 'string' ? j.error_file_id.trim() : '';
  let outputResults: BatchDocResult[] = [];
  let errorResults: BatchDocResult[] = [];
  try {
    outputResults = outputFileId ? await fetchOpenAiBatchResults(key, outputFileId) : [];
    errorResults = errorFileId && errorFileId !== outputFileId
      ? await fetchOpenAiBatchResults(key, errorFileId)
      : [];
  } catch (error) {
    if (error instanceof BatchTerminalPayloadError) {
      const priorResults = [...outputResults, ...errorResults];
      const priorObservedDocIds = priorResults.map((result) => safeTerminalContextDocId(result.docId));
      const partialObservedDocIds = error.context.observedDocIds ?? [];
      const returnedDocs = priorResults.length + (error.context.returnedDocs ?? 0);
      const observedDocIds = [...priorObservedDocIds, ...partialObservedDocIds]
        .slice(0, MAX_TERMINAL_CONTEXT_DOC_IDS);
      const observedDocIdsTruncated = error.context.observedDocIdsTruncated === true
        || priorObservedDocIds.length + partialObservedDocIds.length > MAX_TERMINAL_CONTEXT_DOC_IDS
        || observedDocIds.length < returnedDocs;
      throw new BatchTerminalPayloadError(error.code, status, {
        ...(aggregateUsage ? { aggregateUsage } : {}),
        ...(providerErrors ? { providerErrors } : {}),
        returnedDocs,
        observedDocIds,
        ...(observedDocIdsTruncated ? { observedDocIdsTruncated: true } : {}),
        ...timestamps,
      });
    }
    throw error;
  }
  return {
    done: true,
    failed: status !== 'completed',
    status,
    results: [...outputResults, ...errorResults],
    ...(aggregateUsage ? { aggregateUsage } : {}),
    ...(providerErrors ? { providerErrors } : {}),
    ...timestamps,
  };
}

// ---------------------------------------------------------------------------
// Mistral /v1/batch/jobs over /v1/ocr — JSONL upload; cheapest per page.
// ---------------------------------------------------------------------------

function mistralLine(doc: BatchDoc): string {
  const dataUrl = `data:application/pdf;base64,${arrayBufferToBase64(doc.bytes)}`;
  return JSON.stringify({
    custom_id: doc.docId,
    body: {
      document: { type: 'document_url', document_url: dataUrl },
      document_annotation_format: { type: 'json_schema', json_schema: MISTRAL_ANNOTATION_SCHEMA },
      include_image_base64: false,
    },
  });
}

async function submitMistral(env: Env, model: string, docs: BatchDoc[]): Promise<string> {
  const key = await keyFor(env, 'mistral');
  const jsonl = docs.map((d) => mistralLine(d)).join('\n');
  const fileId = await uploadJsonl('https://api.mistral.ai/v1/files', key, jsonl, { purpose: 'batch' });
  const res = await trackedFetch('https://api.mistral.ai/v1/batch/jobs', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ input_files: [fileId], model, endpoint: '/v1/ocr' }),
  }, { service: 'llm-batch', operation: 'create-batch', model });
  if (!res.ok) throw new Error(`mistral batch create ${res.status} ${await safeText(res)}`);
  const j = (await res.json()) as { id?: string };
  if (!j.id) throw new Error('mistral batch: no id');
  return j.id;
}

/** Decode one Mistral batch output line to rows. Exported for tests. */
export function decodeMistralLine(line: unknown): BatchDocResult {
  const l = line as {
    custom_id?: string;
    response?: { body?: unknown; usage_info?: { pages_processed?: number } };
    body?: unknown;
    error?: unknown;
  };
  const docId = l.custom_id ?? '';
  const body = (l.response && (l.response as { body?: unknown }).body) ?? l.body ?? l.response;
  const usageInfo = body && typeof body === 'object'
    ? (body as { usage_info?: { pages_processed?: number } }).usage_info
    : undefined;
  const usage = normalizeBatchUsage({
    pagesProcessed: usageInfo?.pages_processed ?? l.response?.usage_info?.pages_processed,
  });
  if (l.error || body == null) {
    return { docId, ok: false, error: JSON.stringify(l.error ?? 'no body').slice(0, 300), rows: [], usage };
  }
  try {
    return { docId, ok: true, rows: parseMistralOcrResponse(body), usage };
  } catch (err) {
    return { docId, ok: false, error: (err as Error).message.slice(0, 300), rows: [], usage };
  }
}

async function pollMistral(env: Env, jobId: string): Promise<BatchPoll> {
  const key = await keyFor(env, 'mistral');
  const res = await trackedFetch(
    `https://api.mistral.ai/v1/batch/jobs/${encodeURIComponent(jobId)}`,
    { headers: { authorization: `Bearer ${key}` } },
    { service: 'llm-batch', operation: 'poll-batch' },
  );
  if (!res.ok) throw new Error(`mistral batch get ${res.status} ${await safeText(res)}`);
  const j = (await res.json()) as {
    status?: string;
    output_file?: string | null;
    created_at?: number | null;
    completed_at?: number | null;
  };
  const status = (j.status ?? 'UNKNOWN').toUpperCase();
  const failed = ['FAILED', 'CANCELLED', 'TIMEOUT_EXCEEDED'].includes(status);
  const terminal = failed || status === 'SUCCESS';
  const submittedAt = unixSecondsToIso(j.created_at);
  const terminalAt = terminal ? unixSecondsToIso(j.completed_at) : undefined;
  const timestamps = {
    ...(submittedAt ? { submittedAt } : {}),
    ...(terminalAt ? { terminalAt } : {}),
  };
  if (failed && !j.output_file) {
    return { done: true, failed: true, status, results: [], ...timestamps };
  }
  if ((!failed && status !== 'SUCCESS') || !j.output_file) {
    return { done: false, failed: false, status, results: [], ...timestamps };
  }
  const rj = await trackedFetch(
    `https://api.mistral.ai/v1/files/${j.output_file}/content`,
    { headers: { authorization: `Bearer ${key}` } },
    { service: 'llm-batch', operation: 'fetch-batch-results' },
  );
  if (!rj.ok) throw new Error(`mistral batch results ${rj.status}`);
  const results = parseJsonl(await rj.text()).map(decodeMistralLine);
  return { done: true, failed, status, results, ...timestamps };
}

// ---------------------------------------------------------------------------
// xAI Grok — upload each PDF to the Files API, create an empty batch, then add
// `responses` requests that reference the file by id. Distinct shape: poll
// state.num_pending; results are paginated. Mirrors the working sync adapter.
// ---------------------------------------------------------------------------

async function submitXai(env: Env, model: string, docs: BatchDoc[]): Promise<string> {
  const key = await keyFor(env, 'xai');
  // 1) upload each PDF → file id.
  // Concurrency limit of 25 provides 5x throughput while leaving safe headroom
  // under Cloudflare Workers' hard ceiling of 50 concurrent subrequests per invocation
  // (for batch creation, status polling, and other operations).
  const uploads = await pMap(docs, 25, async (d) => {
    return {
      docId: d.docId,
      chamber: d.chamber,
      fileId: await uploadPdf(
        'https://api.x.ai/v1/files',
        key,
        d.bytes,
        'assistants',
        // xAI batch jobs normally finish within 24h. A 48h provider TTL bounds
        // retention when the Worker cannot retain uploaded ids for eager delete.
        { expiresAfterSeconds: 172_800 },
      ),
    };
  });
  // 2) create an empty batch.
  const cr = await trackedFetch('https://api.x.ai/v1/batches', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'congress-backlog' }),
  }, { service: 'llm-batch', operation: 'create-batch', model });
  if (!cr.ok) throw new Error(`xai batch create ${cr.status} ${await safeText(cr)}`);
  const cj = (await cr.json()) as { id?: string; batch_id?: string };
  const batchId = cj.id ?? cj.batch_id;
  if (!batchId) throw new Error('xai batch: no id');
  // 3) add a request per document referencing its uploaded file.
  const batch_requests = uploads.map((u) => ({
    batch_request_id: u.docId,
    batch_request: {
      responses: {
        model,
        input: [
          { role: 'user', content: [
            { type: 'input_text', text: batchPrompt(u.chamber, 'object') },
            { type: 'input_file', file_id: u.fileId },
          ] },
        ],
      },
    },
  }));
  const ar = await trackedFetch(`https://api.x.ai/v1/batches/${encodeURIComponent(batchId)}/requests`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ batch_requests }),
  }, { service: 'llm-batch', operation: 'add-batch-requests', model });
  if (!ar.ok) throw new Error(`xai batch add-requests ${ar.status} ${await safeText(ar)}`);
  return batchId;
}

/** Decode one xAI batch result item to rows. Exported for tests. */
export function decodeXaiResult(item: unknown): BatchDocResult {
  type XaiUsage = {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    cost_in_usd_ticks?: number;
    num_server_side_tools_used?: number;
  };
  const l = item as {
    batch_request_id?: string;
    batch_result?: {
      response?: {
        chat_get_completion?: { choices?: Array<{ message?: { content?: string } }>; usage?: XaiUsage };
        responses?: ({ usage?: XaiUsage } & Record<string, unknown>);
        usage?: XaiUsage;
      };
      error?: unknown;
    };
    error?: unknown;
  };
  const docId = l.batch_request_id ?? '';
  const resp = l.batch_result?.response;
  const rawUsage = resp?.chat_get_completion?.usage ?? resp?.responses?.usage ?? resp?.usage;
  const usage = normalizeBatchUsage({
    promptTokens: rawUsage?.input_tokens ?? rawUsage?.prompt_tokens,
    completionTokens: rawUsage?.output_tokens ?? rawUsage?.completion_tokens,
    cachedTokens: rawUsage?.input_tokens_details?.cached_tokens ?? rawUsage?.prompt_tokens_details?.cached_tokens,
    costInUsdTicks: rawUsage?.cost_in_usd_ticks,
    attachmentSearchCalls: rawUsage?.num_server_side_tools_used,
  });
  if ((l.error || l.batch_result?.error) ?? !resp) {
    return { docId, ok: false, error: JSON.stringify(l.error ?? l.batch_result?.error ?? 'no response').slice(0, 300), rows: [], usage };
  }
  try {
    let text = '';
    if (resp?.chat_get_completion) text = resp.chat_get_completion.choices?.[0]?.message?.content ?? '';
    else if (resp?.responses) text = extractXaiResponseText(resp.responses);
    if (!text) return { docId, ok: false, error: 'no content in result', rows: [], usage };
    return { docId, ok: true, rows: parseModelJson(text).map(toParsedTx), usage };
  } catch (err) {
    return { docId, ok: false, error: (err as Error).message.slice(0, 300), rows: [], usage };
  }
}

async function pollXai(env: Env, batchId: string): Promise<BatchPoll> {
  const key = await keyFor(env, 'xai');
  const headers = { authorization: `Bearer ${key}` };
  const res = await trackedFetch(
    `https://api.x.ai/v1/batches/${encodeURIComponent(batchId)}`,
    { headers },
    { service: 'llm-batch', operation: 'poll-batch' },
  );
  if (!res.ok) throw new Error(`xai batch get ${res.status} ${await safeText(res)}`);
  const j = (await res.json()) as { state?: { num_pending?: number; num_requests?: number; num_error?: number } };
  const pending = j.state?.num_pending;
  if (typeof pending !== 'number') return { done: false, failed: false, status: 'unknown', results: [] };
  if (pending > 0) return { done: false, failed: false, status: `pending ${pending}/${j.state?.num_requests ?? '?'}`, results: [] };
  // pending === 0 → paginate the results.
  const results: BatchDocResult[] = [];
  let token: string | null = null;
  do {
    const url = `https://api.x.ai/v1/batches/${encodeURIComponent(batchId)}/results?limit=100` + (token ? `&pagination_token=${encodeURIComponent(token)}` : '');
    const rr: Response = await trackedFetch(
      url,
      { headers },
      { service: 'llm-batch', operation: 'fetch-batch-results' },
    );
    if (!rr.ok) throw new Error(`xai batch results ${rr.status}`);
    const rj = (await rr.json()) as { results?: unknown[]; batch_results?: unknown[]; data?: unknown[]; pagination_token?: string | null };
    for (const it of rj.results ?? rj.batch_results ?? rj.data ?? []) results.push(decodeXaiResult(it));
    token = rj.pagination_token ?? null;
  } while (token);
  return { done: true, failed: false, status: 'completed', results };
}

// ---------------------------------------------------------------------------
// Public dispatch + helpers
// ---------------------------------------------------------------------------

/** Split a JSONL blob into parsed objects, ignoring blank lines. Exported for tests. */
export function parseJsonl(text: string): unknown[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((v): v is unknown => v !== null);
}

export function isBatchProvider(v: unknown): v is BatchProvider {
  return v === 'anthropic' || v === 'openai' || v === 'mistral' || v === 'xai';
}

/** Submit a batch; returns the provider's batch/job id to poll later. */
export function submitBatch(env: Env, provider: BatchProvider, model: string, docs: BatchDoc[]): Promise<string> {
  if (isRetiredDisclosureCandidate({ provider, model })) {
    return Promise.reject(new Error('GPT-4o is retired for new disclosure extraction'));
  }
  if (provider === 'anthropic') return submitAnthropic(env, model, docs);
  if (provider === 'openai') return submitOpenAi(env, model, docs);
  if (provider === 'xai') return submitXai(env, model, docs);
  return submitMistral(env, model, docs);
}

/** Poll a previously-submitted batch; when done, results carry decoded rows. */
export function pollBatch(env: Env, provider: BatchProvider, providerBatchId: string): Promise<BatchPoll> {
  if (provider === 'anthropic') return pollAnthropic(env, providerBatchId);
  if (provider === 'openai') return pollOpenAi(env, providerBatchId);
  if (provider === 'xai') return pollXai(env, providerBatchId);
  return pollMistral(env, providerBatchId);
}
