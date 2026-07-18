/**
 * src/extraction/configuredVision.ts
 *
 * Provider-generic PRIMARY/FAILOVER live-ingestion extractor. Reads the
 * per-chamber AGREEMENT_{HOUSE|SENATE|EXEC}_MODEL_A (primary) / _B (failover)
 * Infisical keys and runs the configured candidate through the shared bake-off
 * harness (runCandidateOnDoc), so operators can swap the production extraction
 * model — including non-vision-LLM providers such as mistral OCR or LlamaParse
 * — without a redeploy.
 *
 * Unconfigured chambers (no AGREEMENT_*_MODEL_A) deliberately keep today's
 * behavior by delegating whole-hog to the legacy vision extractor chain (dev
 * environments, or a chamber not yet migrated onto the new key scheme). Once a
 * primary IS configured, that explicit operator choice is authoritative: a
 * failed primary tries the failover (when configured and a different
 * provider), and a failed/absent failover is a hard failure — this extractor
 * never silently reverts to the legacy vision chain once an operator has
 * opted a chamber into explicit model control.
 */

import type { Env, Filing } from '../shared/types';
import { IngestRetryError } from '../ingestion/fetcher';
import { resolveSecrets } from '../secrets/infisical';
import {
  runCandidateOnDoc,
  upgradeRetiredDisclosureCandidate,
  type BakeoffCandidate,
  type CandidateDocResult,
} from './bakeoff';
import { parseCandidate } from './agreement';
import type { Extractor, ExtractorInput, ExtractorResult, ExtractorUsage } from '../extractors/types';

/** Conservative confidence ceiling shared with visionLlm.ts's DEFAULT_CONFIDENCE
 *  convention — most scanned docs should still lean toward human review rather
 *  than a runaway-high model self-reported confidence. */
const DEFAULT_CONFIDENCE = 0.6;

export interface PrimaryFailoverEnv {
  AGREEMENT_SENATE_MODEL_A?: string;
  AGREEMENT_SENATE_MODEL_B?: string;
  AGREEMENT_HOUSE_MODEL_A?: string;
  AGREEMENT_HOUSE_MODEL_B?: string;
  AGREEMENT_EXEC_MODEL_A?: string;
  AGREEMENT_EXEC_MODEL_B?: string;
}

export interface PrimaryFailoverModels {
  primary: BakeoffCandidate | null;
  failover: BakeoffCandidate | null;
}

/** Resolve the explicit per-chamber A (primary) / B (failover) candidates. Either may be null. */
export async function resolvePrimaryFailoverModels(env: Env, chamber: string): Promise<PrimaryFailoverModels> {
  const e = (await resolveSecrets(env, [
    'AGREEMENT_SENATE_MODEL_A',
    'AGREEMENT_SENATE_MODEL_B',
    'AGREEMENT_HOUSE_MODEL_A',
    'AGREEMENT_HOUSE_MODEL_B',
    'AGREEMENT_EXEC_MODEL_A',
    'AGREEMENT_EXEC_MODEL_B',
  ])) as PrimaryFailoverEnv;
  const primaryKey = chamber === 'senate'
    ? e.AGREEMENT_SENATE_MODEL_A
    : chamber === 'executive' ? e.AGREEMENT_EXEC_MODEL_A : e.AGREEMENT_HOUSE_MODEL_A;
  const failoverKey = chamber === 'senate'
    ? e.AGREEMENT_SENATE_MODEL_B
    : chamber === 'executive' ? e.AGREEMENT_EXEC_MODEL_B : e.AGREEMENT_HOUSE_MODEL_B;
  const primary = parseCandidate(primaryKey);
  const failover = parseCandidate(failoverKey);
  return {
    primary: primary ? upgradeRetiredDisclosureCandidate(primary) : null,
    failover: failover ? upgradeRetiredDisclosureCandidate(failover) : null,
  };
}

const candidateLabel = (c: BakeoffCandidate): string => `${c.provider}:${c.model}`;

const PROVIDER_BAN_TTL_SECONDS = 60 * 60;

function isProviderRateLimit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(429|402|too many requests|quota exceeded|rate[- ]?limit|payment required)\b/i.test(message);
}

async function providerBanRetryAfter(env: Env, provider: string): Promise<number | null> {
  if (!env.CONFIG_KV) return null;
  try {
    const raw = await env.CONFIG_KV.get(`provider_ban:${provider}`);
    if (!raw) return null;
    const until = Number(raw);
    if (!Number.isFinite(until) || until <= Date.now()) return null;
    return Math.max(1, Math.min(PROVIDER_BAN_TTL_SECONDS, Math.ceil((until - Date.now()) / 1000)));
  } catch {
    return null;
  }
}

async function recordProviderBan(env: Env, provider: string): Promise<void> {
  if (!env.CONFIG_KV) return;
  try {
    await env.CONFIG_KV.put(
      `provider_ban:${provider}`,
      String(Date.now() + PROVIDER_BAN_TTL_SECONDS * 1000),
      { expirationTtl: PROVIDER_BAN_TTL_SECONDS },
    );
  } catch {
    // A down KV must not hide the provider failure from the queue retry path.
  }
}

/** Stable, secret-safe error string for one candidate's failed read. */
function candidateErrorString(candidate: BakeoffCandidate, result: CandidateDocResult): string {
  return `${candidateLabel(candidate)}: ${result.error ?? 'extraction failed'}`;
}

function toExtractorUsage(usage: CandidateDocResult['usage']): ExtractorUsage | undefined {
  if (!usage) return undefined;
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cachedTokens: usage.cachedTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    cacheWriteOneHourTokens: usage.cacheWriteOneHourTokens,
    pagesProcessed: usage.pagesProcessed,
    serviceTier: usage.serviceTier,
  };
}

/** Map one successful candidate read into the Extractor contract's result shape. */
function toExtractorResult(candidate: BakeoffCandidate, result: CandidateDocResult): ExtractorResult {
  const usage = toExtractorUsage(result.usage);
  const modelVersion = result.resolvedModel ?? candidate.model;
  const extractor = `configured(${candidateLabel(candidate)})`;
  return {
    transactions: result.rows,
    // Cap at the same conservative ceiling visionLlm.ts uses so an
    // over-confident model reading doesn't skip the review-routing safety net.
    confidence: Math.min(result.avgConfidence, DEFAULT_CONFIDENCE),
    raw: JSON.stringify({
      source: 'configuredVision',
      provider: candidate.provider,
      model: candidate.model,
      rowCount: result.rowCount,
    }),
    extractor,
    modelVersion,
    providerRequestId: result.providerRequestId,
    usage,
    modelRuns: [{ extractor, modelVersion, providerRequestId: result.providerRequestId, usage }],
  };
}

/**
 * Provider-generic primary/failover extractor. Wraps the legacy vision-LLM
 * fallback chain (FallbackExtractor(geminiVision, anthropicVision)) so an
 * unmigrated/dev chamber keeps today's behavior, while a migrated chamber's
 * explicit AGREEMENT_*_MODEL_A/_B configuration becomes authoritative.
 */
export class ConfiguredVisionExtractor implements Extractor {
  readonly name = 'configuredVision';

  constructor(
    private readonly env: Env,
    private readonly legacy: Extractor,
  ) {}

  canHandle(f: Filing): boolean {
    return this.legacy.canHandle(f);
  }

  async extract(input: ExtractorInput): Promise<ExtractorResult> {
    const { primary, failover } = await resolvePrimaryFailoverModels(this.env, input.filing.chamber);

    // Dev/unmigrated env: no explicit primary configured, keep today's behavior.
    if (!primary) return this.legacy.extract(input);

    if (!input.bytes) throw new Error(`${this.name}: no bytes provided on ExtractorInput`);
    const bytes = input.bytes;
    const docId = input.filing.docId;

    const candidates = [primary, failover].filter(
      (candidate, index, all): candidate is BakeoffCandidate =>
        Boolean(candidate) && all.findIndex((item) => candidateLabel(item!) === candidateLabel(candidate!)) === index,
    );
    const errors: string[] = [];
    let allFailuresWereRateLimits = true;
    let blockedRetryAfter = 0;

    for (const candidate of candidates) {
      const label = candidateLabel(candidate);
      const retryAfter = await providerBanRetryAfter(this.env, candidate.provider);
      if (retryAfter !== null) {
        blockedRetryAfter = blockedRetryAfter === 0 ? retryAfter : Math.min(blockedRetryAfter, retryAfter);
        errors.push(`${label}: provider rate limit circuit breaker is open`);
        continue;
      }

      let result: CandidateDocResult;
      try {
        result = await runCandidateOnDoc(this.env, candidate, docId, bytes);
      } catch (error) {
        const message = `${label}: ${(error as Error).message}`;
        errors.push(message);
        if (isProviderRateLimit(error)) await recordProviderBan(this.env, candidate.provider);
        else allFailuresWereRateLimits = false;
        continue;
      }
      if (result.ok) return toExtractorResult(candidate, result);

      const message = candidateErrorString(candidate, result);
      errors.push(message);
      if (isProviderRateLimit(result.error)) await recordProviderBan(this.env, candidate.provider);
      else allFailuresWereRateLimits = false;
    }

    if (blockedRetryAfter > 0 && allFailuresWereRateLimits) {
      throw new IngestRetryError(
        `${this.name}: all configured providers are rate-limited; retry-after: ${blockedRetryAfter}s`,
        blockedRetryAfter,
      );
    }
    const primaryErr = errors[0] ?? `${candidateLabel(primary)}: extraction failed`;
    const failoverErr = errors[1] ?? 'no distinct failover configured';
    throw new Error(`${this.name}: primary failed (${primaryErr}); failover failed (${failoverErr})`);
  }
}
