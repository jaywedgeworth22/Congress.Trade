import { randomUUID } from 'node:crypto';
import {
  API_USAGE_MONITOR_INGEST_PATH,
  createUsageTelemetryClient,
} from '../vendor/congress-trading-shared/dist/index.mjs';

const DISABLED = /^(0|false|no|off)$/i;
const SAFE_TAG = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function descriptorTag(name, value) {
  if (typeof value !== 'string' || !SAFE_TAG.test(value)) {
    throw new Error(`operator usage telemetry ${name} must be a stable tag`);
  }
  return value;
}

function normalizeBaseUrl(configuredUrl) {
  let baseUrl = configuredUrl.trim().replace(/\/+$/, '');
  while (baseUrl.endsWith(API_USAGE_MONITOR_INGEST_PATH)) {
    baseUrl = baseUrl.slice(0, -API_USAGE_MONITOR_INGEST_PATH.length).replace(/\/+$/, '');
  }
  return baseUrl;
}

function configuredUsageSender(env) {
  const configuredUrl = env.USAGE_MONITOR_INGEST_URL?.trim();
  const token = env.USAGE_MONITOR_INGEST_TOKEN?.trim();
  if (!configuredUrl || !token) {
    throw new Error(
      'operator usage telemetry is required; inject USAGE_MONITOR_INGEST_URL and USAGE_MONITOR_INGEST_TOKEN',
    );
  }
  const baseUrl = normalizeBaseUrl(configuredUrl);
  if (!baseUrl) throw new Error('operator usage telemetry URL is invalid');
  const client = createUsageTelemetryClient({
    baseUrl,
    token,
    requireExplicitIdempotencyKey: true,
  });
  return (event) => client.send([event]);
}

/**
 * Track one operator-side third-party request. The Usage Monitor transport is
 * deliberately direct and non-recursive; only secret-safe allowlisted fields
 * are sent, never the provider URL, headers, body, or error message.
 */
export async function trackedOperatorFetch(input, init, descriptor, options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const sendUsage = options.sendUsage ?? configuredUsageSender(env);
  const now = options.now ?? Date.now;
  const provider = descriptorTag('provider', descriptor.provider);
  const service = descriptorTag('service', descriptor.service);
  const operation = descriptorTag('operation', descriptor.operation);
  const idempotencyKey = `ct-operator:${provider}:${operation}:${now()}:${randomUUID()}`;
  const startedAt = now();

  const report = async (metadata) => {
    const event = {
      idempotencyKey,
      sourceApp: 'congress-trade',
      environment: (env.USAGE_MONITOR_ENVIRONMENT || env.INFISICAL_ENV || 'operator').trim() || 'operator',
      provider,
      service,
      project: 'congress-trade',
      label: operation,
      keyRef: idempotencyKey,
      billingMode: 'actual',
      metricType: 'usage',
      quantity: 1,
      unit: 'request',
      requests: 1,
      confidence: 'actual',
      occurredAt: new Date().toISOString(),
      metadata,
    };
    try {
      await sendUsage(event);
    } catch (error) {
      throw new Error(
        `operator usage telemetry delivery failed (${error instanceof Error ? error.name : 'unknown'})`,
      );
    }
  };

  try {
    const response = await fetchImpl(input, init);
    await report({
      success: response.ok,
      status: response.status,
      latencyMs: Math.max(0, now() - startedAt),
      rateLimited: response.status === 429,
    });
    return response;
  } catch (error) {
    // If reporting itself failed, it has already surfaced a secret-safe error.
    if (error instanceof Error && error.message.startsWith('operator usage telemetry delivery failed')) {
      throw error;
    }
    await report({
      success: false,
      latencyMs: Math.max(0, now() - startedAt),
      errorType: error instanceof Error ? error.name : 'unknown',
    });
    throw error;
  }
}
