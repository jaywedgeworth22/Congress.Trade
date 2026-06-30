import type { Env } from '../shared/types';
import { resolveSecrets } from '../secrets/infisical';

type UsageMetricType = 'usage' | 'cost' | 'quota' | 'tier' | 'health';
type UsageBillingMode = 'actual' | 'estimated' | 'manual';
type UsageConfidence = 'actual' | 'estimated' | 'manual';
type UsageUnit = 'request' | 'call' | 'token' | 'credit' | 'usd' | 'page' | 'job' | 'document' | 'row' | 'byte';
type UsageLimitWindow = 'minute' | 'day' | 'month' | 'run';

export interface UsageTelemetryEvent {
  provider: string;
  service?: string;
  label?: string;
  keyRef?: string;
  billingMode?: UsageBillingMode;
  metricType?: UsageMetricType;
  quantity?: number;
  unit?: UsageUnit;
  costUsd?: number;
  requests?: number;
  credits?: number;
  limit?: number;
  limitWindow?: UsageLimitWindow;
  tier?: string;
  confidence?: UsageConfidence;
  windowStart?: string;
  windowEnd?: string;
  occurredAt?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

function truthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? '').trim());
}

function cleanNumber(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function cleanMetadata(
  metadata: UsageTelemetryEvent['metadata'],
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
  event: UsageTelemetryEvent,
  environment: string | undefined,
  occurredAt: string,
) {
  return {
    sourceApp: 'congress-trade',
    environment,
    provider: event.provider,
    service: event.service,
    label: event.label,
    keyRef: event.keyRef,
    billingMode: event.billingMode ?? 'estimated',
    metricType: event.metricType ?? 'usage',
    quantity: cleanNumber(event.quantity),
    unit: event.unit,
    costUsd: cleanNumber(event.costUsd),
    requests: event.requests != null ? Math.max(0, Math.floor(event.requests)) : undefined,
    credits: cleanNumber(event.credits),
    limit: cleanNumber(event.limit),
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
  events: UsageTelemetryEvent[],
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
  const payload = {
    events: events.slice(0, 100).map((event) => normalizeEvent(event, environment, occurredAt)),
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn('usage monitor ingest failed:', res.status, body.slice(0, 200));
      return { sent: false, reason: `HTTP ${res.status}` };
    }
    const body = (await res.json().catch(() => ({}))) as { accepted?: number };
    return { sent: true, accepted: body.accepted };
  } catch (err) {
    console.warn('usage monitor ingest error:', (err as Error).message);
    return { sent: false, reason: (err as Error).message };
  }
}
