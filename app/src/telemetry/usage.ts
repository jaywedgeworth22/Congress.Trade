import type { Env } from '../shared/types';
import { resolveSecrets } from '../secrets/infisical';
import {
  createUsageTelemetryClient,
  type UsageTelemetryEvent,
  type UsageTelemetryBillingMode,
  type UsageTelemetryMetricType,
  type UsageTelemetryUnit,
  type UsageTelemetryConfidence,
  type UsageTelemetryLimitWindow,
} from '@jaywedgeworth22/congress-trading-shared';

// Re-export shared types so existing consumers don't need to change their imports.
export type {
  UsageTelemetryEvent,
  UsageTelemetryBillingMode,
  UsageTelemetryMetricType,
  UsageTelemetryUnit,
  UsageTelemetryConfidence,
  UsageTelemetryLimitWindow,
};

// Callers do not set sourceApp (the wrapper injects it) or idempotencyKey (derived by the client).
export interface UsageTelemetryInput {
  provider: string;
  service?: string;
  label?: string;
  keyRef?: string;
  billingMode?: UsageTelemetryBillingMode;
  metricType?: UsageTelemetryMetricType;
  quantity?: number;
  unit?: UsageTelemetryUnit;
  costUsd?: number;
  requests?: number;
  credits?: number;
  limit?: number;
  limitWindow?: UsageTelemetryLimitWindow;
  tier?: string;
  confidence?: UsageTelemetryConfidence;
  windowStart?: string;
  windowEnd?: string;
  occurredAt?: string;
  metadata?: Record<string, string | number | boolean | null>;
  environment?: string;
}

function truthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? '').trim());
}

function cleanMetadata(
  metadata: UsageTelemetryInput['metadata'],
): Record<string, string | number | boolean | null> | undefined {
  if (!metadata) return undefined;
  const clean: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(metadata).slice(0, 50)) {
    const cleanKey = key.trim().slice(0, 80);
    if (!cleanKey) continue;
    if (value == null || typeof value === 'boolean') clean[cleanKey] = value ?? null;
    else if (typeof value === 'number' && Number.isFinite(value)) clean[cleanKey] = value;
    else if (typeof value === 'string') clean[cleanKey] = value.slice(0, 500);
  }
  return Object.keys(clean).length ? clean : undefined;
}

function normalizeEvent(
  event: UsageTelemetryInput,
  environment: string | undefined,
  occurredAt: string,
): UsageTelemetryEvent {
  return {
    sourceApp: 'congress-trade',
    environment: event.environment ?? environment,
    provider: event.provider,
    service: event.service,
    label: event.label,
    keyRef: event.keyRef,
    billingMode: event.billingMode ?? 'estimated',
    metricType: event.metricType ?? 'usage',
    quantity: typeof event.quantity === 'number' && Number.isFinite(event.quantity) && event.quantity >= 0 ? event.quantity : undefined,
    unit: event.unit,
    costUsd: typeof event.costUsd === 'number' && Number.isFinite(event.costUsd) && event.costUsd >= 0 ? event.costUsd : undefined,
    requests: event.requests != null ? Math.max(0, Math.floor(event.requests)) : undefined,
    credits: typeof event.credits === 'number' && Number.isFinite(event.credits) && event.credits >= 0 ? event.credits : undefined,
    limit: typeof event.limit === 'number' && Number.isFinite(event.limit) && event.limit >= 0 ? event.limit : undefined,
    limitWindow: event.limitWindow,
    tier: event.tier,
    confidence: event.confidence ?? 'estimated',
    windowStart: event.windowStart,
    windowEnd: event.windowEnd,
    occurredAt: event.occurredAt ?? occurredAt,
    metadata: cleanMetadata(event.metadata),
  };
}

export async function sendUsageTelemetry(
  env: Env,
  events: UsageTelemetryInput[],
): Promise<{ sent: boolean; accepted?: number; reason?: string }> {
  if (events.length === 0) return { sent: false, reason: 'no events' };
  const secrets = await resolveSecrets(env, [
    'USAGE_MONITOR_ENABLED',
    'USAGE_MONITOR_INGEST_URL',
    'USAGE_MONITOR_INGEST_TOKEN',
    'USAGE_MONITOR_ENVIRONMENT',
  ]);
  if (!truthy(secrets.USAGE_MONITOR_ENABLED)) return { sent: false, reason: 'disabled' };

  const url = secrets.USAGE_MONITOR_INGEST_URL?.trim();
  const token = secrets.USAGE_MONITOR_INGEST_TOKEN?.trim();
  if (!url || !token) return { sent: false, reason: 'not configured' };

  const occurredAt = new Date().toISOString();
  const environment = secrets.USAGE_MONITOR_ENVIRONMENT?.trim() || env.INFISICAL_ENV || undefined;

  try {
    const client = createUsageTelemetryClient({ baseUrl: url, token });
    const normalized = events.slice(0, 100).map((event) => normalizeEvent(event, environment, occurredAt));
    const result = await client.send(normalized);
    return { sent: true, accepted: result.accepted };
  } catch (err) {
    console.warn('usage monitor ingest error:', (err as Error).message);
    return { sent: false, reason: (err as Error).message };
  }
}
