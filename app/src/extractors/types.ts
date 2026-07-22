/**
 * src/extractors/types.ts
 * Pluggable extractor framework. The framework contracts + the env-driven
 * arbitration WIRING are implemented here; the concrete extractors (senateHtml,
 * textPdf, visionLlm) are stubs in src/extraction/* that the extraction agent
 * fills against the Extractor interface below.
 */

import type { Env, Filing, ParsedTx } from '../shared/types.ts';
import { resolveSecret } from '../secrets/infisical.ts';

// ---------------------------------------------------------------------------
// Arbitration merge helpers (pure, unit-testable)
// ---------------------------------------------------------------------------

const ROW_KEY_CACHE = new WeakMap<ParsedTx, string>();

/**
 * Stable matching key for a parsed row: ticker (or asset name when no ticker) +
 * transaction date + transaction type. Two extractors that read the same row
 * should produce the same key even if other fields differ slightly.
 */
export function arbitrationRowKey(tx: ParsedTx): string {
  const cached = ROW_KEY_CACHE.get(tx);
  if (cached !== undefined) return cached;
  const sym = (tx.ticker || tx.assetName || '').trim().toUpperCase();
  const key = `${sym}|${tx.txDate ?? ''}|${tx.txType}`;
  ROW_KEY_CACHE.set(tx, key);
  return key;
}

/** Count how many of the comparable fields two matched rows agree on, out of N. */
export function fieldAgreement(a: ParsedTx, b: ParsedTx): { agree: number; total: number } {
  const eqStr = (x: string | null, y: string | null) =>
    (x ?? '').trim().toUpperCase() === (y ?? '').trim().toUpperCase();
  const checks = [
    a.txType === b.txType,
    a.amountMin === b.amountMin && a.amountMax === b.amountMax,
    eqStr(a.ticker, b.ticker),
    a.owner === b.owner,
    a.isOption === b.isOption,
  ];
  return { agree: checks.filter(Boolean).length, total: checks.length };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function modelRunsForResult(result: ExtractorResult): ExtractorModelRun[] {
  if (result.modelRuns?.length) {
    return result.modelRuns.map((run) => ({
      ...run,
      usage: run.usage ? { ...run.usage } : undefined,
    }));
  }
  if (!result.modelVersion && !result.providerRequestId && !result.usage) return [];
  return [{
    extractor: result.extractor,
    modelVersion: result.modelVersion,
    providerRequestId: result.providerRequestId,
    usage: result.usage ? { ...result.usage } : undefined,
  }];
}

function modelRunsForError(error: object, extractor: string): ExtractorModelRun[] {
  const cast = error as {
    modelRuns?: ExtractorModelRun[];
    resolvedModel?: string;
    providerRequestId?: string;
    usage?: ExtractorUsage;
  };
  if (cast.modelRuns?.length) {
    return cast.modelRuns.map((run) => ({
      ...run,
      usage: run.usage ? { ...run.usage } : undefined,
    }));
  }
  if (!cast.resolvedModel && !cast.providerRequestId && !cast.usage) return [];
  return [{
    extractor,
    modelVersion: cast.resolvedModel,
    providerRequestId: cast.providerRequestId,
    usage: cast.usage ? { ...cast.usage } : undefined,
  }];
}

/**
 * Reconcile two extractor results into one. The PRIMARY row set stays
 * authoritative (deterministic output), but per-row and document confidence are
 * re-weighted by how well the secondary corroborates it:
 *   - matched + all fields agree  -> confidence nudged UP toward agreement.
 *   - matched + partial agreement -> confidence scaled DOWN by the agreement ratio.
 *   - primary-only (no match)     -> confidence halved (only one extractor saw it).
 * Rows the secondary found but the primary missed drag the DOCUMENT confidence
 * down (so the normalizer routes contested docs to human review) without being
 * blindly injected into the output.
 */
export function mergeResults(primary: ExtractorResult, secondary: ExtractorResult): ExtractorResult {
  const secByKey = new Map<string, ParsedTx>();
  for (const tx of secondary.transactions) secByKey.set(arbitrationRowKey(tx), tx);

  const matchedKeys = new Set<string>();
  const transactions: ParsedTx[] = primary.transactions.map((p) => {
    const key = arbitrationRowKey(p);
    const match = secByKey.get(key);
    if (!match) {
      // Only the primary saw this row — corroboration absent.
      return { ...p, confidence: clamp01(p.confidence * 0.5) };
    }
    matchedKeys.add(key);
    const { agree, total } = fieldAgreement(p, match);
    if (agree === total) {
      // Full agreement: average the two and nudge up, capped at 1.
      const base = (p.confidence + match.confidence) / 2;
      return { ...p, confidence: clamp01(base + 0.1) };
    }
    // Partial agreement: scale down by the agreement ratio.
    return { ...p, confidence: clamp01(p.confidence * (agree / total)) };
  });

  // Rows present only in the secondary (primary missed them) = contested doc.
  const secondaryOnly = secondary.transactions.filter(
    (s) => !matchedKeys.has(arbitrationRowKey(s)),
  ).length;
  const primaryOnly = primary.transactions.length - matchedKeys.size;

  const meanRowConf =
    transactions.length > 0
      ? transactions.reduce((s, t) => s + t.confidence, 0) / transactions.length
      : Math.min(primary.confidence, secondary.confidence);

  // Document agreement factor: matched rows / the larger of the two row counts.
  const denom = Math.max(primary.transactions.length, secondary.transactions.length, 1);
  const agreementFactor = matchedKeys.size / denom;
  const docConfidence = clamp01(meanRowConf * (0.5 + 0.5 * agreementFactor));
  const modelRuns = [...modelRunsForResult(primary), ...modelRunsForResult(secondary)];

  return {
    transactions,
    confidence: docConfidence,
    raw: `primary(${primary.extractor}):\n${primary.raw}\n\n---\nsecondary(${secondary.extractor}) [primaryOnly=${primaryOnly}, secondaryOnly=${secondaryOnly}]:\n${secondary.raw}`,
    extractor: `arbitrating(${primary.extractor},${secondary.extractor})`,
    modelVersion: primary.modelVersion,
    providerRequestId: primary.providerRequestId,
    usage: primary.usage ? { ...primary.usage } : undefined,
    modelRuns: modelRuns.length ? modelRuns : undefined,
  };
}

// ---------------------------------------------------------------------------
// Core contracts
// ---------------------------------------------------------------------------

export interface ExtractorUsage {
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  cacheWriteOneHourTokens?: number;
  pagesProcessed?: number;
  serviceTier?: string;
  /** Provider-reported dollar charge for the request (e.g. OpenRouter usage
   *  accounting `usage.cost`); preferred over rate-card estimates downstream. */
  costUsd?: number;
}

/** One provider/model invocation retained across arbitration. */
export interface ExtractorModelRun {
  extractor: string;
  modelVersion?: string;
  providerRequestId?: string;
  usage?: ExtractorUsage;
}

/** Result of running an extractor over one filing. */
export interface ExtractorResult {
  /** Parsed (pre-normalization) transactions. */
  transactions: ParsedTx[];
  /** Document-level confidence in [0,1]. */
  confidence: number;
  /** Raw extracted text/markup retained for audit + review. */
  raw: string;
  /** Name of the extractor that produced this result. */
  extractor: string;
  /** Model/version identifier when an LLM was used (optional). */
  modelVersion?: string;
  /** Provider request identifier retained for audit/support, when returned. */
  providerRequestId?: string;
  /** Billed usage reported by the provider API, when available. */
  usage?: ExtractorUsage;
  /** Every underlying model call when arbitration combines multiple results. */
  modelRuns?: ExtractorModelRun[];
}

/** Input handed to an extractor. One of bytes/html is typically present. */
export interface ExtractorInput {
  filing: Filing;
  /** Queue-lease cancellation propagated to provider transports when present. */
  signal?: AbortSignal;
  /** Raw bytes (PDF) when applicable. */
  bytes?: ArrayBuffer;
  /** Raw HTML (Senate eFD) when applicable. */
  html?: string;
}

/**
 * A pluggable extraction strategy. Implementations live in src/extraction/*.
 * canHandle() lets buildExtractorPipeline() route a filing to the right one.
 */
export interface Extractor {
  /** Stable extractor name, recorded on filings.extractor. */
  name: string;
  /** Optional concrete provider scope for the rate-limit circuit breaker. */
  circuitBreakerName?: string;
  /** True if this extractor can handle the given filing (by docKind etc.). */
  canHandle(f: Filing): boolean;
  /** Run extraction. Implementations resolve to an ExtractorResult. */
  extract(input: ExtractorInput): Promise<ExtractorResult>;
}

// ---------------------------------------------------------------------------
// Arbitration: run a primary extractor, optionally cross-check with a secondary
// ---------------------------------------------------------------------------

/**
 * ArbitratingExtractor wraps a primary Extractor and an optional secondary one.
 *
 * Behaviour (the env-driven WIRING is real; the compare/merge is a documented
 * stub returning the primary result for now):
 *   - ALWAYS runs the primary extractor.
 *   - If a secondary is present AND the arbitration flag is enabled
 *     (env.ARBITRATION_ENABLED === 'true'), ALSO runs the secondary and
 *     arbitrates between the two results. The secondary resolves its key lazily
 *     so it can come from Infisical at extraction time.
 *   - Otherwise returns the primary result unchanged.
 */
export class ArbitratingExtractor implements Extractor {
  readonly name: string;
  readonly circuitBreakerName: string;

  constructor(
    private readonly primary: Extractor,
    private readonly env: Env,
    private readonly secondary?: Extractor,
  ) {
    this.name = `arbitrating(${primary.name}${secondary ? `,${secondary.name}` : ''})`;
    this.circuitBreakerName = primary.circuitBreakerName ?? primary.name;
  }

  canHandle(f: Filing): boolean {
    return this.primary.canHandle(f);
  }

  /** True iff secondary arbitration should run for the current config. The
   *  flag resolves through Infisical (env fallback) at extraction time, so
   *  arbitration can be toggled without a redeploy. */
  private async arbitrationEnabled(): Promise<boolean> {
    if (this.secondary === undefined) return false;
    try {
      const live = (await resolveSecret(this.env, 'ARBITRATION_ENABLED')).value;
      return (live ?? this.env.ARBITRATION_ENABLED) === 'true';
    } catch {
      return this.env.ARBITRATION_ENABLED === 'true';
    }
  }

  async extract(input: ExtractorInput): Promise<ExtractorResult> {
    // 1) Always run the primary extractor.
    const primaryResult = await this.primary.extract(input);

    // 2) Config-driven switch: only arbitrate when fully configured.
    if (!(await this.arbitrationEnabled()) || !this.secondary) {
      return primaryResult;
    }

    // 3) Run the secondary and arbitrate.
    try {
      const secondaryResult = await this.secondary.extract(input);
      return this.arbitrate(primaryResult, secondaryResult);
    } catch (error) {
      // The primary request was already billed. Preserve it alongside any usage
      // attached to the secondary error so the orchestrator can report both.
      if (error && typeof error === 'object') {
        const modelRuns = [
          ...modelRunsForResult(primaryResult),
          ...modelRunsForError(error, this.secondary.name),
        ];
        if (modelRuns.length) {
          try {
            Object.assign(error, { modelRuns });
          } catch {
            // Preserve the provider's original error if it is non-extensible.
          }
        }
      }
      throw error;
    }
  }

  /**
   * Compare/merge primary vs secondary results via {@link mergeResults}:
   * row-by-row reconciliation keyed on ticker/date/type, confidence-weighted by
   * field agreement, with contested documents (rows seen by only one extractor)
   * pushed toward the review queue through a lowered document confidence. The
   * primary row set stays authoritative so output remains deterministic.
   */
  private arbitrate(primary: ExtractorResult, secondary: ExtractorResult): ExtractorResult {
    return mergeResults(primary, secondary);
  }
}

/**
 * FallbackExtractor tries the primary extractor first. If it throws an error
 * (e.g. rate limit, API key missing), it runs the secondary extractor instead,
 * preserving any usage incurred by the failed primary run.
 */
export class FallbackExtractor implements Extractor {
  readonly name: string;
  readonly circuitBreakerName: string;

  constructor(
    private readonly primary: Extractor,
    private readonly secondary: Extractor,
  ) {
    this.name = `fallback(${primary.name},${secondary.name})`;
    this.circuitBreakerName = primary.circuitBreakerName ?? primary.name;
  }

  canHandle(f: Filing): boolean {
    return this.primary.canHandle(f) || this.secondary.canHandle(f);
  }

  async extract(input: ExtractorInput): Promise<ExtractorResult> {
    try {
      return await this.primary.extract(input);
    } catch (error) {
      const secondaryResult = await this.secondary.extract(input);
      if (error && typeof error === 'object') {
        const primaryRuns = modelRunsForError(error, this.primary.name);
        const secRuns = modelRunsForResult(secondaryResult);
        const modelRuns = [...primaryRuns, ...secRuns];
        if (modelRuns.length > 0) {
          secondaryResult.modelRuns = modelRuns;
        }
      }
      return secondaryResult;
    }
  }
}

/**
 * House PDFs often have extractable text even when the cheap byte-sniff
 * classifier misses it. Prefer deterministic text parsing, then fall back to
 * vision only when text extraction produces no usable transaction rows.
 */
export class HousePdfExtractor implements Extractor {
  readonly name: string;
  readonly circuitBreakerName: string;

  constructor(
    private readonly textPdf: Extractor,
    private readonly visionPdf: Extractor,
  ) {
    this.name = `housePdf(${textPdf.name},${visionPdf.name})`;
    this.circuitBreakerName = visionPdf.circuitBreakerName ?? visionPdf.name;
  }

  canHandle(f: Filing): boolean {
    return f.chamber === 'house' && (f.docKind === 'text_pdf' || f.docKind === 'scanned_pdf');
  }

  async extract(input: ExtractorInput): Promise<ExtractorResult> {
    try {
      const textResult = await this.textPdf.extract(input);
      if (textResult.transactions.length > 0) return textResult;
    } catch {
      // Text-layer parsing can fail on image-only or malformed PDFs; vision is the fallback.
    }
    return this.visionPdf.extract(input);
  }
}

// ---------------------------------------------------------------------------
// Pipeline construction
// ---------------------------------------------------------------------------

/**
 * Build the configured ordered extractor pipeline for this environment.
 *
 * Returns references to the concrete (stub) extractor classes that the
 * extraction agent implements in src/extraction/*:
 *   - SenateHtmlExtractor (senate_html)
 *   - TextPdfExtractor    (text_pdf)
 *   - VisionLlmExtractor  (scanned_pdf — uses GEMINI_API_KEY)
 *
 * The classifier picks a docKind; the queue handler iterates this pipeline and
 * uses the first extractor whose canHandle() returns true. The vision extractor
 * is wrapped in an ArbitratingExtractor; when ARBITRATION_API_KEY is set (and
 * ARBITRATION_ENABLED === 'true'), a second, independent vision extractor — a
 * different model keyed by ARBITRATION_API_KEY — cross-checks every scanned doc.
 */
export function buildExtractorPipeline(env: Env): Extractor[] {
  const senateHtml = new SenateHtmlExtractor();
  const textPdf = new TextPdfExtractor();
  
  const geminiVision = new VisionLlmExtractor(env);
  const anthropicVision = new AnthropicVisionExtractor(env);
  const visionLlmWithFallback = new FallbackExtractor(geminiVision, anthropicVision);

  // Per-chamber PRIMARY/FAILOVER extraction model (AGREEMENT_*_MODEL_A/_B),
  // provider-generic via the bake-off harness. Unmigrated/dev chambers (no
  // explicit primary configured) delegate straight through to the legacy
  // vision-LLM fallback chain above, so behavior is unchanged until an
  // operator opts a chamber in.
  const configuredVision = new ConfiguredVisionExtractor(env, visionLlmWithFallback);

  // The secondary is ALWAYS constructed (construction does no I/O): its API
  // key, model, and the ARBITRATION_ENABLED switch all resolve lazily at
  // extraction time (Infisical first, env fallback), so arbitration can be
  // turned on entirely from Infisical without a redeploy. When the flag stays
  // off, ArbitratingExtractor never invokes this instance.
  const secondary = new VisionLlmExtractor(env, {
    apiKeyName: 'ARBITRATION_API_KEY',
    modelEnvName: 'ARBITRATION_MODEL',
    defaultModel: 'gemini-2.5-flash',
    name: 'visionLlm-secondary',
  });

  const visionArbitrated = new ArbitratingExtractor(configuredVision, env, secondary);
  const housePdf = new HousePdfExtractor(textPdf, visionArbitrated);

  return [senateHtml, housePdf, textPdf, visionArbitrated];
}

// ---------------------------------------------------------------------------
// Re-exported concrete extractor stub classes (implemented by extraction agent)
// ---------------------------------------------------------------------------

import { SenateHtmlExtractor } from '../extraction/senateHtml.ts';
import { TextPdfExtractor } from '../extraction/textPdf.ts';
import { VisionLlmExtractor } from '../extraction/visionLlm.ts';
import { AnthropicVisionExtractor } from '../extraction/anthropicVision.ts';
import { ConfiguredVisionExtractor } from '../extraction/configuredVision.ts';

export {
  SenateHtmlExtractor, TextPdfExtractor, VisionLlmExtractor, AnthropicVisionExtractor,
  ConfiguredVisionExtractor,
};
