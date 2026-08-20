/**
 * Shared Sentry event scrubbing.  Credential-bearing query params, headers,
 * and URL userinfo are replaced with `[Filtered]` before an envelope is
 * serialized.  Used by both the Deno SDK adapter and the worker options
 * factory in index.ts.
 */

export const SENTRY_FILTERED_VALUE = '[Filtered]';

const SENTRY_CREDENTIAL_KEYS = new Set([
  'apikey',
  'xapikey',
  'key',
  'token',
  'accesstoken',
  'authtoken',
  'authorization',
  'proxyauthorization',
  'clientsecret',
  'secret',
  'signature',
  'sig',
  'code',
  'password',
  'passwd',
  'session',
  'sessionid',
  'cookie',
  'setcookie',
]);

function normalizedSentryField(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSentryCredentialField(value: string): boolean {
  return SENTRY_CREDENTIAL_KEYS.has(normalizedSentryField(value));
}

function redactSentryQuery(query: string): string {
  const prefix = query.startsWith('?') ? '?' : '';
  const raw = prefix ? query.slice(1) : query;
  if (!raw.includes('=')) return query;
  const params = new URLSearchParams(raw);
  let changed = false;
  for (const key of [...params.keys()]) {
    if (!isSentryCredentialField(key)) continue;
    params.set(key, SENTRY_FILTERED_VALUE);
    changed = true;
  }
  return changed ? `${prefix}${params.toString()}` : query;
}

function redactSentryUrl(urlString: string): string {
  try {
    const url = new URL(urlString);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return urlString;
    let changed = false;
    if (url.username || url.password) {
      url.username = SENTRY_FILTERED_VALUE;
      url.password = SENTRY_FILTERED_VALUE;
      changed = true;
    }
    for (const key of [...url.searchParams.keys()]) {
      if (!isSentryCredentialField(key)) continue;
      url.searchParams.set(key, SENTRY_FILTERED_VALUE);
      changed = true;
    }
    return changed ? url.toString() : urlString;
  } catch {
    return urlString;
  }
}

function isSentryKeyValueCollection(field: string): boolean {
  const normalized = normalizedSentryField(field);
  return normalized.includes('query') || normalized.includes('header');
}

function scrubSentryKeyValueTuple(tuple: unknown[], field: string): unknown[] {
  if (tuple.length < 2 || typeof tuple[0] !== 'string') {
    return tuple.map((item) => scrubSentryValue(item, field));
  }
  const [key, child, ...rest] = tuple;
  return [
    key,
    isSentryCredentialField(key)
      ? SENTRY_FILTERED_VALUE
      : scrubSentryValue(child, key),
    ...rest.map((item) => scrubSentryValue(item, field)),
  ];
}

export function scrubSentryValue(value: unknown, field = ''): unknown {
  if (typeof value === 'string') {
    if (isSentryCredentialField(field)) return SENTRY_FILTERED_VALUE;
    if (normalizedSentryField(field).includes('query')) return redactSentryQuery(value);
    return value.replace(/https?:\/\/[^\s<>"']+/gi, (url) => redactSentryUrl(url));
  }
  if (Array.isArray(value)) {
    if (!isSentryKeyValueCollection(field)) {
      return value.map((item) => scrubSentryValue(item, field));
    }
    if (value.length >= 2 && typeof value[0] === 'string') {
      return scrubSentryKeyValueTuple(value, field);
    }
    return value.map((item) => (
      Array.isArray(item)
        ? scrubSentryKeyValueTuple(item, field)
        : scrubSentryValue(item, field)
    ));
  }
  if (value && typeof value === 'object') {
    const scrubbed: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      scrubbed[key] = isSentryCredentialField(key)
        ? SENTRY_FILTERED_VALUE
        : scrubSentryValue(child, key);
    }
    return scrubbed;
  }
  return value;
}

export function scrubSentryEvent<T>(event: T): T {
  return scrubSentryValue(event) as T;
}
