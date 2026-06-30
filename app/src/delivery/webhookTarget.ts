interface LocalEnv {
  ADMIN_OPEN_IN_DEV?: string;
  APP_BASE_URL?: string;
  USAGE_MONITOR_ENVIRONMENT?: string;
}

interface ValidateWebhookTargetOptions {
  allowLocalhost?: boolean;
}

type HostClassification = 'public' | 'loopback' | 'private';

export function localWebhookTargetsAllowed(
  env: Partial<LocalEnv>,
  requestUrl?: string,
): boolean {
  if (env.ADMIN_OPEN_IN_DEV === 'true') return true;
  if (env.USAGE_MONITOR_ENVIRONMENT?.toLowerCase() === 'local') return true;

  const appBaseUrl = env.APP_BASE_URL?.trim();
  if (appBaseUrl) {
    return isLoopbackUrl(appBaseUrl) && (!requestUrl || isLoopbackUrl(requestUrl));
  }

  return requestUrl ? isLoopbackUrl(requestUrl) : false;
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
  if (url.protocol !== 'https:') {
    return 'targetUrl must use https:// outside localhost development';
  }

  return null;
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
