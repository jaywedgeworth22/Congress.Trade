/**
 * src/shared/proxyFetch.ts
 *
 * Lightweight proxied fetch client wrapper for Deno and Node environments.
 * When a residential proxy URL (e.g. Tailscale http://100.113.106.39:3128) is provided,
 * outbound HTTP/HTTPS requests are tunneled through the proxy so requests appear
 * from the residential IP (bypassing datacenter anti-bot filters like Imperva).
 */

declare const Deno: {
  createHttpClient?: (options: { proxy?: { url: string } }) => unknown;
} | undefined;

const clientCache = new Map<string, unknown>();

/**
 * Creates or retrieves a cached HTTP client configured with the given proxy URL.
 */
export function getDenoHttpClient(proxyUrl?: string): unknown | undefined {
  if (!proxyUrl || typeof Deno === 'undefined' || typeof Deno.createHttpClient !== 'function') {
    return undefined;
  }
  const cleanUrl = proxyUrl.trim();
  if (!cleanUrl) return undefined;

  let client = clientCache.get(cleanUrl);
  if (!client) {
    try {
      client = Deno.createHttpClient({ proxy: { url: cleanUrl } });
      clientCache.set(cleanUrl, client);
    } catch (err) {
      console.warn(`proxyFetch: failed to create Deno HTTP client for ${cleanUrl}:`, (err as Error).message);
      return undefined;
    }
  }
  return client;
}

/**
 * Wraps a fetch function to route outbound requests through the specified proxy URL.
 * If no proxy is configured or the proxy client cannot be initialized, returns the underlying fetch.
 */
export function createProxiedFetch(
  proxyUrl?: string,
  baseFetch: typeof fetch = globalThis.fetch,
): typeof fetch {
  if (!proxyUrl) return baseFetch;
  const cleanUrl = proxyUrl.trim();
  if (!cleanUrl) return baseFetch;

  const client = getDenoHttpClient(cleanUrl);
  if (!client) return baseFetch;

  return async function proxiedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const fetchInit = { ...init, client } as RequestInit & { client?: unknown };
    return baseFetch(input, fetchInit as RequestInit);
  };
}

/**
 * Helper to resolve the effective residential proxy URL from Env or process.env.
 */
export function resolveResidentialProxyUrl(env?: {
  RESIDENTIAL_PROXY_URL?: string;
  SENATE_PROXY_URL?: string;
  HTTP_PROXY?: string;
  HTTPS_PROXY?: string;
}): string | undefined {
  return (
    env?.RESIDENTIAL_PROXY_URL?.trim() ||
    env?.SENATE_PROXY_URL?.trim() ||
    (typeof process !== 'undefined' ? process.env?.RESIDENTIAL_PROXY_URL?.trim() : undefined) ||
    (typeof process !== 'undefined' ? process.env?.SENATE_PROXY_URL?.trim() : undefined) ||
    (typeof process !== 'undefined' ? process.env?.HTTPS_PROXY?.trim() : undefined) ||
    (typeof process !== 'undefined' ? process.env?.HTTP_PROXY?.trim() : undefined) ||
    undefined
  );
}
