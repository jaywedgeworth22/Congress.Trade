import { createUsageTelemetryClient } from '@jaywedgeworth22/congress-trading-shared';
import { resolveSecrets } from '../secrets/infisical';
import type { Env } from '../shared/types';
import type { CandidateDocResult, ExtractionRunKind } from './bakeoff';

export async function pushExtractionTelemetry(
  env: Env,
  result: CandidateDocResult,
  kind: ExtractionRunKind
): Promise<void> {
  try {
    const secrets = await resolveSecrets(env, [
      'USAGE_MONITOR_ENABLED',
      'USAGE_MONITOR_INGEST_URL',
      'USAGE_MONITOR_INGEST_TOKEN',
      'USAGE_MONITOR_ENVIRONMENT',
    ]);
    const isEnabled = /^(1|true|yes|on)$/i.test((secrets.USAGE_MONITOR_ENABLED ?? '').trim());
    if (!isEnabled || !secrets.USAGE_MONITOR_INGEST_URL || !secrets.USAGE_MONITOR_INGEST_TOKEN) return;

    const client = createUsageTelemetryClient({
      baseUrl: secrets.USAGE_MONITOR_INGEST_URL.trim(),
      token: secrets.USAGE_MONITOR_INGEST_TOKEN.trim(),
    });

    const envName = secrets.USAGE_MONITOR_ENVIRONMENT || env.INFISICAL_ENV || 'production';
    const now = new Date().toISOString();
    
    // We assume 1 LLM request per candidate doc evaluated.
    const baseEvent = {
      sourceApp: 'congress-trade',
      environment: envName,
      provider: result.provider,
      service: 'llm',
      label: kind,
      billingMode: 'estimated' as const,
      confidence: 'estimated' as const,
      occurredAt: now,
      metadata: {
        docId: result.docId,
        model: result.model,
        ok: result.ok,
        latencyMs: result.latencyMs,
      },
    };

    const events: any[] = [];
    const usage = result.usage;
    
    if (usage && (usage.promptTokens || usage.completionTokens)) {
      const total = (usage.promptTokens || 0) + (usage.completionTokens || 0);
      events.push({
        ...baseEvent,
        metricType: 'usage',
        quantity: total > 0 ? total : undefined,
        unit: 'token',
        requests: 1,
        metadata: {
          ...baseEvent.metadata,
          promptTokens: usage.promptTokens ?? null,
          completionTokens: usage.completionTokens ?? null,
          cachedTokens: usage.cachedTokens ?? null,
        }
      });
    } else {
      events.push({
        ...baseEvent,
        metricType: 'usage',
        quantity: undefined, // Unknown token count
        unit: 'request', // fallback to tracking by request volume
        requests: 1,
      });
    }

    // Fire and forget, don't block the caller
    await client.send(events).catch((e: Error) => console.warn('telemetry push failed', e.message));
  } catch (err) {
    console.warn('pushExtractionTelemetry error:', (err as Error).message);
  }
}
