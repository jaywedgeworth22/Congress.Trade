/**
 * src/ingestion/residentialProxyHealth.ts
 *
 * Probe and health helpers for the residential Tailscale proxy.
 */

import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';
import { resolveResidentialProxyUrl } from '../shared/proxyFetch.ts';
import type { Env } from '../shared/types.ts';

export interface ResidentialProxyHealthResult {
  configured: boolean;
  proxyUrl?: string;
  reachable: boolean;
  status?: number;
  service?: string;
  uptime?: number;
  latencyMs?: number;
  error?: string;
}

/**
 * Probe the health endpoint of the residential proxy daemon.
 */
export async function probeResidentialProxyHealth(
  proxyUrlOrEnv?: string | Env,
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs = 5000,
): Promise<ResidentialProxyHealthResult> {
  const proxyUrl = typeof proxyUrlOrEnv === 'string'
    ? proxyUrlOrEnv
    : resolveResidentialProxyUrl(proxyUrlOrEnv);

  if (!proxyUrl) {
    return {
      configured: false,
      reachable: false,
    };
  }

  const cleanUrl = proxyUrl.replace(/\/$/, '');
  const healthEndpoint = `${cleanUrl}/health`;
  const t0 = Date.now();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await trackedFetch(
      healthEndpoint,
      {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      },
      { service: 'filing-discovery', operation: 'probe-residential-proxy-health' },
      fetchImpl,
    );

    clearTimeout(timeoutId);
    const latencyMs = Date.now() - t0;

    if (res.ok) {
      let data: { ok?: boolean; service?: string; uptime?: number } = {};
      try {
        data = (await res.json()) as typeof data;
      } catch {}
      return {
        configured: true,
        proxyUrl: cleanUrl,
        reachable: true,
        status: res.status,
        service: data.service,
        uptime: data.uptime,
        latencyMs,
      };
    }

    return {
      configured: true,
      proxyUrl: cleanUrl,
      reachable: false,
      status: res.status,
      latencyMs,
      error: `HTTP ${res.status}`,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    return {
      configured: true,
      proxyUrl: cleanUrl,
      reachable: false,
      latencyMs: Date.now() - t0,
      error: (err as Error).message,
    };
  }
}
