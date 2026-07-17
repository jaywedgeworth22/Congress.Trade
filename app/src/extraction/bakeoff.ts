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

import { resolveSecret } from '../secrets/infisical';
import { run } from '../shared/db';
import { uuid } from '../shared/ids';
import { pushExtractionTelemetry } from './telemetry';
import { OpenRouterVisionExtractor } from './openRouterVision';
import { classifyProviderFailure,
  type ProviderFailureStatus } from './providerFailure';

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
 * Provider-neutral default lineup (overridable per request). Five companies via
 * direct keys — Google, OpenAI, Anthropic, Mistral, xAI — plus a curated set of
 * OpenRouter-transported candidates. The GPT-4o family is intentionally absent
 * from new disclosure extraction (on BOTH the direct and OpenRouter transports;
 * see isRetiredDisclosureCandidate): GPT-5.6 Terra is the routine default, Luna
 * is the lower-cost first pass, and Sol is the difficult-scan adjudicator.
 *
 * Each direct provider takes a PDF via its own native path: Gemini/OpenAI/
 * Anthropic as an inline base64 part, Mistral via `/v1/ocr`, and xAI via the
 * Files API (upload → `file_id` → attach to a `grok-4.3` `/v1/responses` call;
 * the model's server-side OCR+vision reads the scan). grok-4.3 is agentic, so
 * it is the slowest/most expensive candidate — keep bake-off `docIds` small
 * when it's in.
 *
 * Every openrouter slug below was verified LIVE against the OpenRouter models
 * API on 2026-07-16. Fourteen prior entries that no longer exist on OpenRouter
 * (gemini-pro-1.5 / flash-1.5 / 2.0-flash-thinking-exp, claude-3.5/3.7 family,
 * mistral-large-2411, grok-2-vision-1212, qwen-2.5-vl-72b:free, qwen-max,
 * yi-large, kimi-chat, minimax-hep-lite, deepseek-chat/-coder) were removed —
 * every benchmark cell for a dead slug could only fail. deepseek-chat/-coder
 * were replaced by the live deepseek-v4-pro/-flash pair per owner directive.
 * `google/gemini-3.5-flash` is the OR-transport route around the currently
 * blocked direct Gemini key.
 */
export const DEFAULT_CANDIDATES: BakeoffCandidate[] = [
  { provider: 'gemini', model: 'gemini-3.5-flash' },
  { provider: 'openai', model: 'gpt-5.6-terra' },
  { provider: 'openai', model: 'gpt-5.6-luna' },
  { provider: 'openai', model: 'gpt-5.6-sol' },
  { provider: 'anthropic', model: 'claude-sonnet-5' },
  { provider: 'anthropic', model: 'claude-sonnet-5' },
  { provider: 'mistral', model: 'mistral-ocr-latest' },
  { provider: 'xai', model: 'grok-4.3' },
  { provider: 'openrouter', model: 'deepseek/deepseek-v4-pro' },
  { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash' },
  { provider: 'openrouter', model: 'qwen/qwen3-vl-30b-a3b-instruct' },
  { provider: 'openrouter', model: 'qwen/qwen3-vl-8b-instruct' },
  { provider: 'openrouter', model: 'google/gemini-2.5-flash-lite' },
  { provider: 'openrouter', model: 'amazon/nova-lite-v1' },
  { provider: 'openrouter', model: 'z-ai/glm-4.6v' },
  { provider: 'openrouter', model: 'google/gemini-3.5-flash' },
  { provider: 'openrouter', model: 'qwen/qwen-2.5-72b-instruct' },
  { provider: 'openrouter', model: 'openrouter/auto' },
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


/** Token usage extracted from a provider response, shared shape across providers. */
type UsageInfo = CandidateDocResult['usage'];



type ProviderError = Error & {
  usage?: UsageInfo;
  resolvedModel?: string;
  providerRequestId?: string;
  serviceTier?: string;
  /** True once an asynchronous provider accepted a potentially billable job. */
  acceptedJob?: boolean;
};


/** Run one candidate over one document's bytes, timing it and trapping errors. */
export const EXTRACTION_SCHEMA_VERSION = 'stock-act-transactions-v2';

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
      rows: [] };
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
      rows: [] };
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
            cached: true };
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
    if (provider === 'openrouter') {
      const result = await new OpenRouterVisionExtractor(env, { model, apiKey: key }).extract({
        filing: { docKind: 'scanned_pdf', chamber } as never,
        bytes });
      rows = result.transactions;
      usage = result.usage;
      resolvedModel = result.modelVersion;
      providerRequestId = result.providerRequestId;
    } else {
      throw new Error(`bakeoff: unsupported provider ${provider}`);
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
      serviceTier };
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
      serviceTier: cast.serviceTier };
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
      consensusAgreement: round2(agreement.get(label(c)) ?? 0) };
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
