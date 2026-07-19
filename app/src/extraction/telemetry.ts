import type { Env } from '../shared/types';
import {
  recordMeasuredThirdPartyUsage,
  stableMeasuredUsageIdempotencyKey,
  type MeasuredThirdPartyUsage,
} from '../shared/thirdPartyTelemetry';
import type { CandidateDocResult, ExtractionRunKind } from './bakeoff';
import { priceBenchmarkUsage } from './benchmarkMetrics';

type ResultMeasurement = Omit<
  Extract<MeasuredThirdPartyUsage, { idempotencyKey?: undefined }>,
  'idempotencyKey' | 'occurredAt'
>;

async function recordResultMeasurement(
  env: Env,
  result: CandidateDocResult,
  suffix: string,
  measurement: ResultMeasurement,
): Promise<void> {
  // Thread the provider's own call/generation id (when the candidate
  // extractor captured one) onto every pushed measurement dimension, so the
  // monitor can verify reported cost against the provider's own record. Kept
  // separate from the idempotency-key derivation below — this only adds a
  // field on the outgoing event, it does not change what identifies it.
  const withProvenance: ResultMeasurement = result.providerRequestId
    ? { ...measurement, providerRequestId: result.providerRequestId }
    : measurement;
  if (result.providerRequestId && result.occurredAt) {
    await recordMeasuredThirdPartyUsage(env, {
      ...withProvenance,
      idempotencyKey: await stableMeasuredUsageIdempotencyKey(
        'provider-result',
        suffix,
        result.provider,
        result.providerRequestId,
      ),
      occurredAt: result.occurredAt,
    });
    return;
  }
  await recordMeasuredThirdPartyUsage(
    env,
    result.occurredAt ? { ...withProvenance, occurredAt: result.occurredAt } : withProvenance,
  );
}

/**
 * Add provider-reported billable units to the request-attempt event emitted by
 * trackedFetch. No fallback request event is needed here: trackedFetch already
 * records every success, failure, and retry exactly once.
 */
export async function pushExtractionTelemetry(
  env: Env,
  result: CandidateDocResult,
  kind: ExtractionRunKind,
): Promise<void> {
  const usage = result.usage;
  if (!usage) return;
  const costInUsdTicks = usage.costInUsdTicks;
  // Provider-native charge: xAI reports exact ticks; OpenRouter usage
  // accounting reports the charged dollars directly (usage.cost → costUsd).
  const providerNativeCostUsd =
    typeof costInUsdTicks === 'number' && Number.isFinite(costInUsdTicks) && costInUsdTicks >= 0
      ? costInUsdTicks / 10_000_000_000
      : typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd) && usage.costUsd >= 0
        ? usage.costUsd
        : null;
  if (providerNativeCostUsd != null) {
    const costUsd = providerNativeCostUsd;
    const measuredCost = {
      provider: result.provider,
      service: 'llm',
      operation: `${kind}-provider-cost`,
      model: result.resolvedModel ?? result.model,
      metricType: 'cost' as const,
      quantity: costUsd,
      unit: 'usd' as const,
      costUsd,
      billingMode: 'actual' as const,
      confidence: 'actual' as const,
      metadata: {
        ...(costInUsdTicks == null ? {} : { costInUsdTicks }),
        success: result.ok,
        latencyMs: result.latencyMs,
        ...(usage.attachmentSearchCalls == null
          ? {}
          : { attachmentSearchCalls: usage.attachmentSearchCalls }),
      },
    };
    await recordResultMeasurement(
      env,
      result,
      'cost',
      measuredCost,
    );
  } else {
    // No provider-native charge (every provider besides xAI). Estimate the
    // dollar cost from measured token/page usage against the shared
    // benchmark rate card, and mark it clearly as an estimate — never
    // 'actual' — so downstream consumers cannot mistake it for a billed
    // amount.
    const estimatedCost = priceBenchmarkUsage({
      provider: result.provider,
      model: result.model,
      resolvedModel: result.resolvedModel ?? null,
      invoked: true,
      usage: {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        cachedTokens: usage.cachedTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        cacheWriteOneHourTokens: usage.cacheWriteOneHourTokens,
        serviceTier: usage.serviceTier ?? result.serviceTier,
        pagesProcessed: usage.pagesProcessed,
      },
    });
    if (estimatedCost.costUsd != null) {
      await recordResultMeasurement(env, result, 'cost', {
        provider: result.provider,
        service: 'llm',
        operation: `${kind}-provider-cost`,
        model: result.resolvedModel ?? result.model,
        metricType: 'cost' as const,
        quantity: estimatedCost.costUsd,
        unit: 'usd' as const,
        costUsd: estimatedCost.costUsd,
        billingMode: 'estimated' as const,
        confidence: 'estimated' as const,
        metadata: {
          success: result.ok,
          latencyMs: result.latencyMs,
          costSource: estimatedCost.costSource,
        },
      });
    }
  }
  const promptTokens = usage.promptTokens;
  const completionTokens = usage.completionTokens;
  if (
    typeof promptTokens === 'number' && Number.isFinite(promptTokens) && promptTokens >= 0
    && typeof completionTokens === 'number' && Number.isFinite(completionTokens) && completionTokens >= 0
    && promptTokens + completionTokens > 0
  ) {
    await recordResultMeasurement(env, result, 'tokens', {
      provider: result.provider,
      service: 'llm',
      operation: `${kind}-tokens`,
      model: result.resolvedModel ?? result.model,
      quantity: promptTokens + completionTokens,
      unit: 'token',
      billingMode: 'actual',
      confidence: 'actual',
      metadata: {
        promptTokens,
        completionTokens,
        ...(usage.cachedTokens == null ? {} : { cachedTokens: usage.cachedTokens }),
        ...(usage.cacheWriteTokens == null ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
        ...(usage.cacheWriteOneHourTokens == null
          ? {}
          : { cacheWriteOneHourTokens: usage.cacheWriteOneHourTokens }),
        ...((usage.serviceTier ?? result.serviceTier) == null
          ? {}
          : { serviceTier: usage.serviceTier ?? result.serviceTier }),
        ...(usage.costInUsdTicks == null ? {} : { costInUsdTicks: usage.costInUsdTicks }),
        ...(usage.attachmentSearchCalls == null
          ? {}
          : { attachmentSearchCalls: usage.attachmentSearchCalls }),
        success: result.ok,
        latencyMs: result.latencyMs,
      },
    });
  }
  if ((usage.pagesProcessed ?? 0) > 0) {
    await recordResultMeasurement(env, result, 'pages', {
      provider: result.provider,
      service: 'ocr',
      operation: `${kind}-pages`,
      model: result.resolvedModel ?? result.model,
      quantity: usage.pagesProcessed,
      unit: 'page',
      billingMode: 'actual',
      confidence: 'actual',
      metadata: { success: result.ok, latencyMs: result.latencyMs },
    });
  }
  if (
    typeof usage.attachmentSearchCalls === 'number'
    && Number.isInteger(usage.attachmentSearchCalls)
    && usage.attachmentSearchCalls > 0
  ) {
    await recordResultMeasurement(env, result, 'attachment-search', {
      provider: result.provider,
      service: 'llm',
      operation: `${kind}-attachment-search`,
      model: result.resolvedModel ?? result.model,
      quantity: usage.attachmentSearchCalls,
      unit: 'call',
      billingMode: 'actual',
      confidence: 'actual',
      metadata: {
        toolName: 'attachment_search',
        success: result.ok,
        latencyMs: result.latencyMs,
        ...(usage.costInUsdTicks == null ? {} : { costInUsdTicks: usage.costInUsdTicks }),
      },
    });
  }
}
