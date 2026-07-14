/**
 * Complete outbound-call accounting for Congress.Trade.
 *
 * Every deployed Worker-owned third-party HTTP attempt passes through `trackedFetch`.
 * The active Worker invocation's Env is carried with AsyncLocalStorage, so
 * provider adapters can remain test-injectable without threading Env through
 * every helper. Each attempt (including retries and failures) is durably handed
 * to INGEST_QUEUE (or the failure-only R2 outbox) and delivered to
 * usage.jays.services.
 *
 * Security invariant: the queued event never contains a URL, host, path, query,
 * header, request/response body, user identifier, or provider error message.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import {
  API_USAGE_MONITOR_INGEST_PATH,
  createUsageTelemetryClient,
  UsageTelemetryEventSchema,
} from '@jaywedgeworth22/congress-trading-shared';
import { resolveSecrets } from '../secrets/infisical';
import type { Env, ThirdPartyUsageTelemetryEvent } from './types';

interface TelemetryContext {
  env: Env;
  /** Prevent self-observation while resolving/sending Usage Monitor events. */
  suppressed: boolean;
}

const context = new AsyncLocalStorage<TelemetryContext>();
const USAGE_TELEMETRY_FALLBACK_PREFIX = '_ops/usage-telemetry/';

export interface UsageTelemetryFallbackHealth {
  available: boolean;
  pending: number | null;
  truncated: boolean;
}

/** Secret-free local durability snapshot for admin diagnostics. */
export async function inspectUsageTelemetryFallback(
  env: Env,
  limit = 1_000,
): Promise<UsageTelemetryFallbackHealth> {
  const storage = (env as Partial<Env>).RAW_FILES;
  if (!storage?.list) return { available: false, pending: null, truncated: false };
  try {
    const listed = await storage.list({
      prefix: USAGE_TELEMETRY_FALLBACK_PREFIX,
      limit: Math.max(1, Math.min(1_000, Math.floor(limit))),
    });
    return {
      available: true,
      pending: listed.objects.length,
      truncated: listed.truncated === true,
    };
  } catch {
    return { available: false, pending: null, truncated: false };
  }
}

export type DynamicThirdPartyTarget =
  | 'subscriber-webhook'
  | 'peer-app'
  | 'filing-source'
  | 'seed-source'
  | 'infisical';

export interface TrackedFetchDescriptor {
  /** Stable product surface, for example `llm`, `market-data`, or `oauth`. */
  service: string;
  /** Stable operation name. Never pass a URL/path/user value here. */
  operation: string;
  /** Concrete model/version when this is a model call. */
  model?: string;
  /** Required only when the destination is intentionally operator/user configured. */
  dynamicTarget?: DynamicThirdPartyTarget;
}

export interface MeasuredThirdPartyUsage {
  provider: string;
  service: string;
  operation: string;
  /** Stable key for retry-safe measured events. Omit for one-shot measurements. */
  idempotencyKey?: string;
  model?: string;
  metricType?: 'usage' | 'cost' | 'limit';
  quantity?: number;
  unit?: ThirdPartyUsageTelemetryEvent['unit'];
  costUsd?: number;
  requests?: number;
  credits?: number;
  billingMode?: ThirdPartyUsageTelemetryEvent['billingMode'];
  confidence?: ThirdPartyUsageTelemetryEvent['confidence'];
  metadata?: Record<string, string | number | boolean | null>;
}

const HOST_PROVIDERS = new Map<string, string>([
  ['api.openai.com', 'openai'],
  ['api.anthropic.com', 'anthropic'],
  ['api.mistral.ai', 'mistral'],
  ['api.x.ai', 'xai'],
  ['generativelanguage.googleapis.com', 'gemini'],
  ['api.cloud.llamaindex.ai', 'llamaparse'],
  ['financialmodelingprep.com', 'fmp'],
  ['api.unusualwhales.com', 'unusual-whales'],
  ['api.quiverquant.com', 'quiver-quant'],
  ['api.massive.com', 'massive'],
  ['finnhub.io', 'finnhub'],
  ['api.twelvedata.com', 'twelve-data'],
  ['api-v2.intrinio.com', 'intrinio'],
  ['api.tiingo.com', 'tiingo'],
  ['www.sec.gov', 'sec-edgar'],
  ['data.sec.gov', 'sec-edgar'],
  ['disclosures-clerk.house.gov', 'house-disclosures'],
  ['efdsearch.senate.gov', 'senate-disclosures'],
  ['extapps2.oge.gov', 'oge'],
  ['raw.githubusercontent.com', 'github'],
  ['unitedstates.github.io', 'github'],
  ['house-stock-watcher-data.s3-us-west-2.amazonaws.com', 'house-stock-watcher'],
  ['img.logo.dev', 'logo-dev'],
  ['api.resend.com', 'resend'],
  ['api.stripe.com', 'stripe'],
  ['oauth2.googleapis.com', 'google'],
  ['openidconnect.googleapis.com', 'google'],
  ['cloudflare-dns.com', 'cloudflare-dns'],
  ['app.infisical.com', 'infisical'],
  ['usage.jays.services', 'usage-monitor'],
]);

const HOST_SUFFIX_PROVIDERS: Array<[suffix: string, provider: string]> = [
  ['.cloudflareaccess.com', 'cloudflare-access'],
  ['.sentry.io', 'sentry'],
];

const DYNAMIC_PROVIDERS: Record<DynamicThirdPartyTarget, string> = {
  'subscriber-webhook': 'webhook',
  'peer-app': 'peer-app',
  'filing-source': 'filing-source',
  'seed-source': 'seed-source',
  infisical: 'infisical',
};

const SAFE_METADATA_KEYS = new Set([
  'model',
  'success',
  'status',
  'latencyMs',
  'rateLimited',
  'errorType',
  'promptTokens',
  'completionTokens',
  'cachedTokens',
  'cacheWriteTokens',
  'cacheWriteOneHourTokens',
  'serviceTier',
  'toolName',
  'attachmentSearchCalls',
  'costInUsdTicks',
  'pagesProcessed',
  'costSource',
  'costCoverage',
  'benchmarkRunId',
  'job',
  'fmpCallsThisRun',
  'priceProvider',
  'errors',
]);

function stableTag(value: string, fallback: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return (normalized || fallback).slice(0, 80);
}

function safeMetadata(
  metadata: Record<string, string | number | boolean | null> | undefined,
): Record<string, string | number | boolean | null> {
  const safe: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (!SAFE_METADATA_KEYS.has(key)) continue;
    if (typeof value === 'number') {
      if (Number.isFinite(value) && value >= 0) safe[key] = value;
    } else if (typeof value === 'string') {
      safe[key] = stableTag(value, 'unknown');
    } else {
      safe[key] = value;
    }
  }
  return safe;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

export function providerForThirdPartyRequest(
  input: RequestInfo | URL,
  dynamicTarget?: DynamicThirdPartyTarget,
): string {
  if (dynamicTarget) return DYNAMIC_PROVIDERS[dynamicTarget];
  try {
    const hostname = new URL(requestUrl(input)).hostname.toLowerCase().replace(/\.$/, '');
    return HOST_PROVIDERS.get(hostname)
      ?? HOST_SUFFIX_PROVIDERS.find(([suffix]) => hostname.endsWith(suffix))?.[1]
      ?? 'external-api';
  } catch {
    return 'external-api';
  }
}

function environmentName(env: Env): string {
  return (env.USAGE_MONITOR_ENVIRONMENT || env.INFISICAL_ENV || 'production').trim() || 'production';
}

function eventId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

function nonNegativeFinite(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function baseEvent(
  env: Env,
  input: {
    provider: string;
    service: string;
    operation: string;
    idempotencyKey?: string;
    model?: string;
    metricType: 'usage' | 'cost' | 'limit';
    billingMode: ThirdPartyUsageTelemetryEvent['billingMode'];
    confidence: ThirdPartyUsageTelemetryEvent['confidence'];
  },
): ThirdPartyUsageTelemetryEvent {
  const service = stableTag(input.service, 'external-api');
  const operation = stableTag(input.operation, 'request');
  const idempotencyKey = input.idempotencyKey
    ? stableTag(input.idempotencyKey, 'ct-third-party')
    : eventId('ct-third-party');
  return {
    idempotencyKey,
    sourceApp: 'congress-trade',
    environment: environmentName(env),
    provider: stableTag(input.provider, 'external-api'),
    service,
    project: 'congress-trade',
    label: operation,
    keyRef: idempotencyKey,
    billingMode: input.billingMode,
    metricType: input.metricType,
    confidence: input.confidence,
    occurredAt: new Date().toISOString(),
    metadata: input.model ? { model: stableTag(input.model, 'unknown-model') } : undefined,
  };
}

/**
 * Queue one event without ever failing the product call that generated it.
 * Queue rejection falls back to R2; only exhaustion of both paths is logged.
 */
export async function enqueueUsageTelemetryEvent(
  env: Env,
  event: ThirdPartyUsageTelemetryEvent,
  options: { silentFailure?: boolean } = {},
): Promise<boolean> {
  try {
    await env.INGEST_QUEUE.send({ type: 'usage.telemetry', event });
    return true;
  } catch {
    // Failure-only durable outbox. RAW_FILES is an existing strongly-consistent
    // R2 binding, and the receiver idempotency key makes Queue/R2 races safe.
    return persistUsageTelemetryFallback(env, event, options);
  }
}

function usageTelemetryFallbackKey(event: ThirdPartyUsageTelemetryEvent): string {
  return `${USAGE_TELEMETRY_FALLBACK_PREFIX}${encodeURIComponent(event.idempotencyKey)}.json`;
}

function parseUsageTelemetryFallback(raw: string): ThirdPartyUsageTelemetryEvent {
  const parsed = UsageTelemetryEventSchema.parse(JSON.parse(raw));
  if (
    !parsed.idempotencyKey
    || parsed.sourceApp !== 'congress-trade'
    || parsed.project !== 'congress-trade'
    || !parsed.environment
    || !parsed.service
    || !parsed.label
    || !parsed.keyRef
    || !parsed.occurredAt
    || !['usage', 'cost', 'limit'].includes(parsed.metricType)
  ) {
    throw new Error('fallback telemetry event is not a Congress.Trade event');
  }
  return parsed as unknown as ThirdPartyUsageTelemetryEvent;
}

/** Preserve an event when Queue delivery or receiver delivery cannot proceed. */
export async function persistUsageTelemetryFallback(
  env: Env,
  event: ThirdPartyUsageTelemetryEvent,
  options: { silentFailure?: boolean } = {},
): Promise<boolean> {
  try {
    await env.RAW_FILES.put(usageTelemetryFallbackKey(event), JSON.stringify(event), {
      httpMetadata: { contentType: 'application/json' },
    });
    return true;
  } catch (error) {
    // Sentry's own transport uses silentFailure: logging failure to meter the
    // logging transport would recursively create another Sentry envelope.
    if (!options.silentFailure) {
      console.error('usage telemetry durability exhausted', {
        provider: event.provider,
        service: event.service,
        label: event.label,
        errorType: error instanceof Error ? error.name : 'unknown',
      });
    }
    return false;
  }
}

export interface TrackedFetchRuntimeOptions {
  /** Explicit Env for SDK-owned transports that flush outside the handler ALS scope. */
  envOverride?: Env;
  /** Prevent recursive logging when metering an observability transport itself. */
  silentQueueFailure?: boolean;
}

/** Add provider-reported tokens/pages/credits or priced cost alongside request attempts. */
export async function recordMeasuredThirdPartyUsage(
  env: Env,
  usage: MeasuredThirdPartyUsage,
): Promise<boolean> {
  const event = baseEvent(env, {
    provider: usage.provider,
    service: usage.service,
    operation: usage.operation,
    idempotencyKey: usage.idempotencyKey,
    model: usage.model,
    metricType: usage.metricType ?? (usage.costUsd != null ? 'cost' : 'usage'),
    billingMode: usage.billingMode ?? 'actual',
    confidence: usage.confidence ?? 'actual',
  });
  event.quantity = nonNegativeFinite(usage.quantity);
  event.unit = usage.unit;
  event.costUsd = nonNegativeFinite(usage.costUsd);
  const requests = nonNegativeFinite(usage.requests);
  event.requests = requests == null ? undefined : Math.floor(requests);
  event.credits = nonNegativeFinite(usage.credits);
  event.metadata = safeMetadata({ ...(event.metadata ?? {}), ...(usage.metadata ?? {}) });
  return enqueueUsageTelemetryEvent(env, event);
}

/** Run one Worker invocation inside the Env context consumed by trackedFetch. */
export function withThirdPartyTelemetry<T>(env: Env, fn: () => T): T {
  return context.run({ env, suppressed: false }, fn);
}

/**
 * Bootstrap escape hatch used only by the Usage Monitor delivery transport.
 * Without it, an Infisical cache miss while delivering telemetry would create
 * another telemetry event and could amplify indefinitely during an outage.
 */
export function withoutThirdPartyTelemetry<T>(env: Env, fn: () => T): T {
  return context.run({ env, suppressed: true }, fn);
}

/**
 * Fetch a third-party resource and report this exact network attempt. Repeated
 * calls made by retry loops therefore produce repeated attempt events.
 */
export async function trackedFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  descriptor: TrackedFetchDescriptor,
  fetchImpl: typeof fetch = fetch,
  runtime: TrackedFetchRuntimeOptions = {},
): Promise<Response> {
  const activeContext = context.getStore();
  const env = activeContext?.suppressed ? undefined : (runtime.envOverride ?? activeContext?.env);
  const provider = providerForThirdPartyRequest(input, descriptor.dynamicTarget);
  // The Usage Monitor client intentionally uses its own explicit raw transport;
  // routing it through this function would recursively meter telemetry itself.
  if (provider === 'usage-monitor') {
    throw new Error('usage-monitor ingest must use the explicit telemetry transport');
  }

  const startedAt = Date.now();
  try {
    const response = await fetchImpl(input, init);
    if (env) {
      const event = baseEvent(env, {
        provider,
        service: descriptor.service,
        operation: descriptor.operation,
        model: descriptor.model,
        metricType: 'usage',
        billingMode: 'actual',
        confidence: 'actual',
      });
      event.quantity = 1;
      event.unit = 'request';
      event.requests = 1;
      event.metadata = {
        ...(event.metadata ?? {}),
        success: response.ok,
        status: response.status,
        latencyMs: Math.max(0, Date.now() - startedAt),
        rateLimited: response.status === 429,
      };
      await enqueueUsageTelemetryEvent(env, event, { silentFailure: runtime.silentQueueFailure });
    }
    return response;
  } catch (error) {
    if (env) {
      const event = baseEvent(env, {
        provider,
        service: descriptor.service,
        operation: descriptor.operation,
        model: descriptor.model,
        metricType: 'usage',
        billingMode: 'actual',
        confidence: 'actual',
      });
      event.quantity = 1;
      event.unit = 'request';
      event.requests = 1;
      event.metadata = {
        ...(event.metadata ?? {}),
        success: false,
        latencyMs: Math.max(0, Date.now() - startedAt),
        errorType: stableTag(error instanceof Error ? error.name : 'unknown', 'unknown'),
      };
      await enqueueUsageTelemetryEvent(env, event, { silentFailure: runtime.silentQueueFailure });
    }
    throw error;
  }
}

/**
 * The shared client accepts a service base URL and appends its canonical ingest
 * path. Older Congress.Trade config stored the full endpoint, so strip that
 * suffix before constructing the client to avoid appending it twice.
 */
export function normalizeUsageMonitorBaseUrl(configuredUrl: string): string {
  let baseUrl = configuredUrl.trim().replace(/\/+$/, '');
  while (baseUrl.endsWith(API_USAGE_MONITOR_INGEST_PATH)) {
    baseUrl = baseUrl.slice(0, -API_USAGE_MONITOR_INGEST_PATH.length).replace(/\/+$/, '');
  }
  return baseUrl;
}

/** Queue-consumer transport. The shared client is intentionally not tracked. */
export async function deliverUsageTelemetryEvent(
  env: Env,
  event: ThirdPartyUsageTelemetryEvent,
): Promise<void> {
  await withoutThirdPartyTelemetry(env, async () => {
    const secrets = await resolveSecrets(env, [
      'USAGE_MONITOR_ENABLED',
      'USAGE_MONITOR_INGEST_URL',
      'USAGE_MONITOR_INGEST_TOKEN',
    ]);
    if (/^(0|false|no|off)$/i.test((secrets.USAGE_MONITOR_ENABLED ?? '').trim())) return;
    const configuredUrl = secrets.USAGE_MONITOR_INGEST_URL?.trim();
    const token = secrets.USAGE_MONITOR_INGEST_TOKEN?.trim();
    if (!configuredUrl || !token) throw new Error('usage telemetry ingest is not configured');
    const baseUrl = normalizeUsageMonitorBaseUrl(configuredUrl);
    if (!baseUrl) throw new Error('usage telemetry ingest URL is invalid');
    const client = createUsageTelemetryClient({
      baseUrl,
      token,
      requireExplicitIdempotencyKey: true,
    });
    await client.send([event]);
  });
}

export interface UsageTelemetryFallbackFlushResult {
  listed: number;
  delivered: number;
  failed: number;
}

/**
 * Drain a bounded batch from the failure-only R2 outbox. Receiver failures are
 * retained without logging/Sentry capture to avoid outage amplification.
 */
export async function flushUsageTelemetryFallback(
  env: Env,
  options: { limit?: number } = {},
): Promise<UsageTelemetryFallbackFlushResult> {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 25)));
  const listed = await env.RAW_FILES.list({
    prefix: USAGE_TELEMETRY_FALLBACK_PREFIX,
    limit,
  });
  let delivered = 0;
  let failed = 0;
  for (const object of listed.objects) {
    try {
      const body = await env.RAW_FILES.get(object.key);
      if (!body) continue;
      const event = parseUsageTelemetryFallback(await body.text());
      await deliverUsageTelemetryEvent(env, event);
      await env.RAW_FILES.delete(object.key);
      delivered += 1;
    } catch {
      failed += 1;
    }
  }
  return { listed: listed.objects.length, delivered, failed };
}
