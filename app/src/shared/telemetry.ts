import type { Env } from './types';
import { recordMeasuredThirdPartyUsage } from './thirdPartyTelemetry';

export interface AiUsageParams {
  provider: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  cacheWriteOneHourTokens?: number;
  serviceTier?: string;
  /** Source component generating this event (e.g. 'orchestrator' or 'bakeoff'). */
  component?: string;
  /** Provider-side call/generation id for monitor-side spend verification.
   *  Pass `undefined` (never `""`) when absent. */
  providerRequestId?: string;
}

/** Report provider-measured token usage through the durable telemetry queue. */
export async function reportAiUsage(env: Env, params: AiUsageParams): Promise<void> {
  const promptTokens = params.promptTokens;
  const completionTokens = params.completionTokens;
  if (
    typeof promptTokens !== 'number' || !Number.isFinite(promptTokens) || promptTokens < 0
    || typeof completionTokens !== 'number' || !Number.isFinite(completionTokens) || completionTokens < 0
    || promptTokens + completionTokens <= 0
  ) return;
  await recordMeasuredThirdPartyUsage(env, {
    provider: params.provider,
    service: 'llm',
    operation: `${params.component || 'extraction'}-tokens`,
    model: params.model,
    quantity: promptTokens + completionTokens,
    unit: 'token',
    billingMode: 'actual',
    confidence: 'actual',
    providerRequestId: params.providerRequestId,
    metadata: {
      promptTokens,
      completionTokens,
      ...(params.cachedTokens == null ? {} : { cachedTokens: params.cachedTokens }),
      ...(params.cacheWriteTokens == null ? {} : { cacheWriteTokens: params.cacheWriteTokens }),
      ...(params.cacheWriteOneHourTokens == null
        ? {}
        : { cacheWriteOneHourTokens: params.cacheWriteOneHourTokens }),
      ...(params.serviceTier == null ? {} : { serviceTier: params.serviceTier }),
    },
  });
}
