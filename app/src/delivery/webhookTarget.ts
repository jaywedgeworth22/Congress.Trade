interface LocalEnv {
  ADMIN_OPEN_IN_DEV?: string;
  APP_BASE_URL?: string;
  USAGE_MONITOR_ENVIRONMENT?: string;
}

export interface ValidateWebhookTargetOptions {
  allowLocalhost?: boolean;
  fetchImpl?: typeof fetch;
}

type HostClassification = 'public' | 'loopback' | 'private';

export function localWebhookTargetsAllowed(
  env: Partial<LocalEnv>,
  requestUrl?: string,
): boolean {
  // ADMIN_OPEN_IN_DEV controls admin authentication only; it must never turn a
  // production-origin request into permission to target loopback services.
  if (requestUrl && isLoopbackUrl(requestUrl)) return true;
  if (env.USAGE_MONITOR_ENVIRONMENT?.toLowerCase() === 'local') return true;

  const appBaseUrl = env.APP_BASE_URL?.trim();
  if (appBaseUrl) {
    return isLoopbackUrl(appBaseUrl) && !requestUrl;
  }
  return false;
}

export function validateWebhookTargetUrl(
  targetUrl: string | null,
  opts: ValidateWebhookTargetOptions = {},
): string | null {
  if (!targetUrl) return 'targetUrl is required for webhook subscriptions';

  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return 'targetUrl must be a valid absolute URL';
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'targetUrl must use https:// outside localhost development';
  }

  const hostClass = classifyHostname(url.hostname);
  if (hostClass === 'loopback') {
    if (opts.allowLocalhost) return null;
    return 'targetUrl cannot use localhost or loopback addresses outside local development';
  }
  if (hostClass === 'private') {
    return 'targetUrl cannot use private, link-local, or reserved addresses';
  }
  // Workers fetch cannot reliably target raw IP-address URLs. Reject public
  // literals too so an accepted subscription cannot deterministically exhaust
  // every delivery. Explicit local development retains loopback support above.
  if (isIpLiteral(url.hostname)) {
    return 'targetUrl must use a hostname; IP-address URLs are not supported';
  }
  if (url.protocol !== 'https:') {
    return 'targetUrl must use https:// outside localhost development';
  }

  return null;
}

interface DnsJsonResponse {
  Status?: number;
  Answer?: Array<{ type?: number; data?: string }>;
}

/**
 * Resolve public hostnames through Cloudflare DNS before every persisted target
 * change and immediately before delivery. The Workers compatibility flag is a
 * second routing-level backstop against DNS rebinding between this check/fetch.
 */
export async function validatePublicWebhookTarget(
  targetUrl: string | null,
  opts: ValidateWebhookTargetOptions = {},
): Promise<string | null> {
  const literalError = validateWebhookTargetUrl(targetUrl, opts);
  if (literalError) return literalError;
  const url = new URL(targetUrl as string);
  const hostClass = classifyHostname(url.hostname);
  if (hostClass === 'loopback') return opts.allowLocalhost ? null : 'targetUrl cannot use localhost';
  if (isIpLiteral(url.hostname)) return 'targetUrl must use a hostname; IP-address URLs are not supported';

  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const answers: string[] = [];
    for (const type of ['A', 'AAAA']) {
      const endpoint = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(url.hostname)}&type=${type}`;
      const response = await fetchImpl(endpoint, { headers: { accept: 'application/dns-json' } });
      if (!response.ok) return 'webhook target DNS validation failed';
      const body = await response.json() as DnsJsonResponse;
      if (body.Status !== undefined && body.Status !== 0) continue;
      for (const answer of body.Answer ?? []) {
        if ((answer.type === 1 || answer.type === 28) && answer.data) answers.push(answer.data);
      }
    }
    if (answers.length === 0) return 'webhook target did not resolve to a public address';
    if (answers.some((answer) => classifyHostname(answer) !== 'public')) {
      return 'webhook target resolved to a private, loopback, link-local, or reserved address';
    }
    return null;
  } catch {
    return 'webhook target DNS validation failed';
  }
}

function isIpLiteral(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  return parseIpv4(host) !== null || host.includes(':');
}

function isLoopbackUrl(value: string): boolean {
  try {
    return classifyHostname(new URL(value).hostname) === 'loopback';
  } catch {
    return false;
  }
}

function classifyHostname(hostname: string): HostClassification {
  const host = normalizeHostname(hostname);
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';

  const ipv4 = parseIpv4(host);
  if (ipv4) return classifyIpv4(ipv4);

  if (host.includes(':')) return classifyIpv6(host);

  return 'public';
}

function normalizeHostname(hostname: string): string {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  while (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

function parseIpv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
  if (bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) return null;
  return bytes;
}

function classifyIpv4(bytes: number[]): HostClassification {
  const [a, b, c] = bytes;
  if (a === 127) return 'loopback';
  if (
    a === 0 ||
    a === 10 ||
    a === 255 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  ) {
    return 'private';
  }
  return 'public';
}

function classifyIpv6(host: string): HostClassification {
  if (host === '::1') return 'loopback';
  if (host === '::') return 'private';

  const mapped = parseIpv4MappedIpv6(host);
  if (mapped) return classifyIpv4(mapped);

  const first = firstIpv6Hextet(host);
  if (first == null) return 'private';
  if ((first >= 0xfc00 && first <= 0xfdff) || (first >= 0xfe80 && first <= 0xfebf)) {
    return 'private';
  }
  if (first >= 0xff00) return 'private';
  if (host.startsWith('2001:db8:') || host === '2001:db8') return 'private';

  return 'public';
}

function parseIpv4MappedIpv6(host: string): number[] | null {
  if (!host.startsWith('::ffff:')) return null;
  const tail = host.slice('::ffff:'.length);
  const dotted = parseIpv4(tail);
  if (dotted) return dotted;

  const parts = tail.split(':');
  if (parts.length !== 2) return null;
  const high = parseHextet(parts[0]);
  const low = parseHextet(parts[1]);
  if (high == null || low == null) return null;
  return [(high >> 8) & 255, high & 255, (low >> 8) & 255, low & 255];
}

function firstIpv6Hextet(host: string): number | null {
  const first = host.split(':').find(Boolean);
  return first ? parseHextet(first) : null;
}

function parseHextet(value: string): number | null {
  if (!/^[0-9a-f]{1,4}$/i.test(value)) return null;
  return Number.parseInt(value, 16);
}
