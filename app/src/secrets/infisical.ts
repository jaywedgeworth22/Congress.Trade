/**
 * Runtime secret resolver backed by Infisical machine identities.
 *
 * Cloudflare Worker secrets should only need to hold the Infisical bootstrap
 * credentials. Provider keys are read from Infisical on demand and cached in
 * isolate memory for a short TTL. No resolved secret values are written to KV,
 * D1, R2, logs, or diagnostics.
 */

import type { Env } from '../shared/types';

type SourceName = 'app' | 'shared';

interface SourceConfig {
  name: SourceName;
  projectId?: string;
  clientId?: string;
  clientSecret?: string;
  secretPath: string;
}

interface CacheEntry {
  key: string;
  values: Record<string, string>;
  fetchedAt: number;
  expiresAt: number;
  errors: string[];
  sources: Array<{ name: SourceName; configured: boolean; ok: boolean; count: number; error?: string }>;
}

export interface SecretResolution {
  value?: string;
  source: 'infisical' | 'env' | 'missing';
}

export interface SecretResolverStatus {
  enabled: boolean;
  cacheReady: boolean;
  cacheAgeSeconds: number | null;
  cacheTtlSeconds: number;
  cacheExpiresInSeconds: number | null;
  envFallbackAllowed: boolean;
  lastRefreshAt: string | null;
  errors: string[];
  sources: Array<{ name: SourceName; configured: boolean; ok: boolean; count: number; error?: string }>;
}

const DEFAULT_BASE_URL = 'https://app.infisical.com';
const DEFAULT_ENV = 'prod';
const DEFAULT_TTL_SECONDS = 600;

const cache = new Map<string, CacheEntry>();

function cleanBaseUrl(raw: string | undefined): string {
  return (raw || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function cacheTtlSeconds(env: Env): number {
  const n = Number.parseInt(env.INFISICAL_CACHE_TTL_SECONDS || '', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 3600) : DEFAULT_TTL_SECONDS;
}

function envName(env: Env): string {
  return (env.INFISICAL_ENV || DEFAULT_ENV).trim() || DEFAULT_ENV;
}

function envFallbackAllowed(env: Env): boolean {
  return env.INFISICAL_ALLOW_ENV_FALLBACK !== 'false';
}

function sourceConfigs(env: Env): SourceConfig[] {
  return [
    {
      name: 'shared',
      projectId: env.INFISICAL_SHARED_PROJECT_ID,
      clientId: env.INFISICAL_SHARED_CLIENT_ID,
      clientSecret: env.INFISICAL_SHARED_CLIENT_SECRET,
      secretPath: env.INFISICAL_SHARED_SECRET_PATH || '/',
    },
    {
      name: 'app',
      projectId: env.INFISICAL_APP_PROJECT_ID,
      clientId: env.INFISICAL_APP_CLIENT_ID,
      clientSecret: env.INFISICAL_APP_CLIENT_SECRET,
      secretPath: env.INFISICAL_APP_SECRET_PATH || '/',
    },
  ];
}

function sourceConfigured(source: SourceConfig): boolean {
  return Boolean(source.projectId && source.clientId && source.clientSecret);
}

function configuredSources(env: Env): SourceConfig[] {
  return sourceConfigs(env).filter(sourceConfigured);
}

function resolverEnabled(env: Env): boolean {
  return configuredSources(env).length > 0;
}

function cacheKey(env: Env): string {
  return [
    cleanBaseUrl(env.INFISICAL_BASE_URL),
    envName(env),
    env.INFISICAL_SHARED_PROJECT_ID || '',
    env.INFISICAL_SHARED_SECRET_PATH || '/',
    env.INFISICAL_APP_PROJECT_ID || '',
    env.INFISICAL_APP_SECRET_PATH || '/',
  ].join('|');
}

function redactedError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]').slice(0, 300);
}

async function login(baseUrl: string, source: SourceConfig): Promise<string> {
  const res = await fetch(`${baseUrl}/api/v1/auth/universal-auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: source.clientId, clientSecret: source.clientSecret }),
  });
  const body = (await res.json().catch(() => ({}))) as { accessToken?: string; token?: string; message?: string };
  if (!res.ok) throw new Error(`Infisical ${source.name} auth failed: HTTP ${res.status} ${body.message || ''}`.trim());
  const token = body.accessToken || body.token;
  if (!token) throw new Error(`Infisical ${source.name} auth failed: no access token`);
  return token;
}

function secretEntries(payload: unknown): Array<{ key: string; value: string }> {
  const root = payload as {
    secrets?: unknown;
    secret?: unknown;
    data?: { secrets?: unknown; secret?: unknown };
  };
  const raw = root.secrets ?? root.data?.secrets ?? root.secret ?? root.data?.secret ?? [];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const shapedKey = obj.secretKey ?? obj.key ?? obj.name;
    const shapedValue = obj.secretValue ?? obj.value;
    if (typeof shapedKey !== 'string' && typeof shapedValue !== 'string') {
      return Object.entries(obj)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .map(([key, value]) => ({ key, value }));
    }
  }
  const arr = Array.isArray(raw) ? raw : [raw];
  const entries: Array<{ key: string; value: string }> = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const key = obj.secretKey ?? obj.key ?? obj.name;
    const value = obj.secretValue ?? obj.value;
    if (typeof key === 'string' && typeof value === 'string') entries.push({ key, value });
  }
  return entries;
}

async function fetchSourceSecrets(baseUrl: string, infisicalEnv: string, source: SourceConfig): Promise<Record<string, string>> {
  const token = await login(baseUrl, source);
  const params = new URLSearchParams({
    workspaceId: source.projectId || '',
    environment: infisicalEnv,
    secretPath: source.secretPath || '/',
    include_imports: 'true',
    recursive: 'true',
  });
  const res = await fetch(`${baseUrl}/api/v3/secrets/raw?${params.toString()}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) throw new Error(`Infisical ${source.name} secrets failed: HTTP ${res.status} ${body.message || ''}`.trim());
  return Object.fromEntries(secretEntries(body).map((entry) => [entry.key, entry.value]));
}

export async function refreshSecrets(env: Env): Promise<SecretResolverStatus> {
  const key = cacheKey(env);
  const ttlMs = cacheTtlSeconds(env) * 1000;
  const now = Date.now();
  const baseUrl = cleanBaseUrl(env.INFISICAL_BASE_URL);
  const infisicalEnv = envName(env);
  const sources = sourceConfigs(env);
  const values: Record<string, string> = {};
  const errors: string[] = [];
  const sourceStatus: CacheEntry['sources'] = [];

  for (const source of sources) {
    if (!sourceConfigured(source)) {
      sourceStatus.push({ name: source.name, configured: false, ok: false, count: 0 });
      continue;
    }
    try {
      const sourceValues = await fetchSourceSecrets(baseUrl, infisicalEnv, source);
      Object.assign(values, sourceValues);
      sourceStatus.push({ name: source.name, configured: true, ok: true, count: Object.keys(sourceValues).length });
    } catch (err) {
      const error = redactedError(err);
      errors.push(error);
      sourceStatus.push({ name: source.name, configured: true, ok: false, count: 0, error });
    }
  }

  const entry: CacheEntry = {
    key,
    values,
    fetchedAt: now,
    expiresAt: now + ttlMs,
    errors,
    sources: sourceStatus,
  };
  cache.set(key, entry);
  return statusFromEntry(env, entry);
}

async function cacheEntry(env: Env): Promise<CacheEntry | null> {
  if (!resolverEnabled(env)) return null;
  const key = cacheKey(env);
  const existing = cache.get(key);
  if (existing && existing.expiresAt > Date.now()) return existing;
  await refreshSecrets(env);
  return cache.get(key) ?? null;
}

export async function resolveSecret(env: Env, key: keyof Env & string): Promise<SecretResolution> {
  const entry = await cacheEntry(env);
  const value = entry?.values[key];
  if (value) return { value, source: 'infisical' };
  const envValue = envFallbackAllowed(env) ? env[key] : undefined;
  return typeof envValue === 'string' && envValue.length > 0
    ? { value: envValue, source: 'env' }
    : { source: 'missing' };
}

export async function resolveSecrets<T extends string>(env: Env, keys: T[]): Promise<Record<T, string | undefined>> {
  const entries = await Promise.all(keys.map(async (key) => [key, (await resolveSecret(env, key as keyof Env & string)).value] as const));
  return Object.fromEntries(entries) as Record<T, string | undefined>;
}

function statusFromEntry(env: Env, entry: CacheEntry | null): SecretResolverStatus {
  const now = Date.now();
  return {
    enabled: resolverEnabled(env),
    cacheReady: Boolean(entry && Object.keys(entry.values).length > 0),
    cacheAgeSeconds: entry ? Math.max(0, Math.round((now - entry.fetchedAt) / 1000)) : null,
    cacheTtlSeconds: cacheTtlSeconds(env),
    cacheExpiresInSeconds: entry ? Math.max(0, Math.round((entry.expiresAt - now) / 1000)) : null,
    envFallbackAllowed: envFallbackAllowed(env),
    lastRefreshAt: entry ? new Date(entry.fetchedAt).toISOString() : null,
    errors: entry?.errors ?? [],
    sources: entry?.sources ?? sourceConfigs(env).map((source) => ({
      name: source.name,
      configured: sourceConfigured(source),
      ok: false,
      count: 0,
    })),
  };
}

export function getSecretResolverStatus(env: Env): SecretResolverStatus {
  return statusFromEntry(env, cache.get(cacheKey(env)) ?? null);
}
