import type { Env } from '../shared/types';
import { recordMeasuredThirdPartyUsage } from '../shared/thirdPartyTelemetry';
import type { CandidateDocResult, ExtractionRunKind } from './bakeoff';

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
  if (
    typeof costInUsdTicks === 'number'
    && Number.isFinite(costInUsdTicks)
    && costInUsdTicks >= 0
  ) {
    const costUsd = costInUsdTicks / 10_000_000_000;
    await recordMeasuredThirdPartyUsage(env, {
      provider: result.provider,
      service: 'llm',
      operation: `${kind}-provider-cost`,
      ...(result.providerRequestId
        ? { idempotencyKey: `ct-sync-${result.provider}-${result.providerRequestId}-cost` }
        : {}),
      model: result.resolvedModel ?? result.model,
      metricType: 'cost',
      quantity: costUsd,
      unit: 'usd',
      costUsd,
      billingMode: 'actual',
      confidence: 'actual',
      metadata: {
        costInUsdTicks,
        success: result.ok,
        latencyMs: result.latencyMs,
        ...(usage.attachmentSearchCalls == null
          ? {}
          : { attachmentSearchCalls: usage.attachmentSearchCalls }),
      },
    });
  }
  const promptTokens = usage.promptTokens;
  const completionTokens = usage.completionTokens;
  if (
    typeof promptTokens === 'number' && Number.isFinite(promptTokens) && promptTokens >= 0
    && typeof completionTokens === 'number' && Number.isFinite(completionTokens) && completionTokens >= 0
    && promptTokens + completionTokens > 0
  ) {
    await recordMeasuredThirdPartyUsage(env, {
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
    await recordMeasuredThirdPartyUsage(env, {
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
    await recordMeasuredThirdPartyUsage(env, {
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
