import { createUsageTelemetryClient } from '@jaywedgeworth22/congress-trading-shared';
import { resolveSecrets } from '../secrets/infisical';
import type { Env } from './types';

export interface AiUsageParams {
  provider: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  /** Source component generating this event (e.g. 'orchestrator' or 'bakeoff') */
  component?: string;
}

/**
 * Lazily resolves telemetry credentials from Infisical/Env and reports AI model
 * token usage to the Usage Monitor. Fails silently so telemetry bugs never
 * break the primary ingestion pipeline.
 */
export async function reportAiUsage(env: Env, params: AiUsageParams): Promise<void> {
  try {
    const secrets = await resolveSecrets(env, [
      'USAGE_MONITOR_ENABLED',
      'USAGE_MONITOR_INGEST_URL',
      'USAGE_MONITOR_INGEST_TOKEN',
      'USAGE_MONITOR_ENVIRONMENT',
    ]);

    const isEnabled = /^(1|true|yes|on)$/i.test((secrets.USAGE_MONITOR_ENABLED ?? '').trim());
    if (!isEnabled || !secrets.USAGE_MONITOR_INGEST_URL || !secrets.USAGE_MONITOR_INGEST_TOKEN) {
      return; // Telemetry disabled or missing config
    }

    const client = createUsageTelemetryClient({
      baseUrl: secrets.USAGE_MONITOR_INGEST_URL.trim(),
      token: secrets.USAGE_MONITOR_INGEST_TOKEN.trim(),
    });

    const environment = secrets.USAGE_MONITOR_ENVIRONMENT || env.INFISICAL_ENV || 'development';
    const component = params.component || 'extraction';
    
    // We send separate events for prompt vs completion tokens to match the UI/billing
    // granularity of LLM providers.
    const promises: Promise<any>[] = [];

    if (typeof params.promptTokens === 'number' && params.promptTokens > 0) {
      promises.push(
        client.send([{
          sourceApp: 'congress-trade',
          environment,
          provider: params.provider.toLowerCase(),
          service: 'llm',
          label: `${component}: prompt tokens`,
          billingMode: 'actual',
          metricType: 'usage',
          quantity: params.promptTokens,
          unit: 'token',
          confidence: 'actual',
          metadata: {
            model: params.model,
            cachedTokens: params.cachedTokens ?? null,
          },
        }]).then(() => {}).catch(() => {})
      );
    }

    if (typeof params.completionTokens === 'number' && params.completionTokens > 0) {
      promises.push(
        client.send([{
          sourceApp: 'congress-trade',
          environment,
          provider: params.provider.toLowerCase(),
          service: 'llm',
          label: `${component}: completion tokens`,
          billingMode: 'actual',
          metricType: 'usage',
          quantity: params.completionTokens,
          unit: 'token',
          confidence: 'actual',
          metadata: {
            model: params.model,
          },
        }]).then(() => {}).catch(() => {})
      );
    }

    await Promise.all(promises);
  } catch (err) {
    console.warn(`telemetry: failed to report AI usage for ${params.provider}`, (err as Error).message);
  }
}
