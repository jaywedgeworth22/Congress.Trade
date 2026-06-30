import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../shared/types';
import { refreshSecrets, resolveSecret } from '../infisical';

function env(extra: Partial<Env> = {}): Env {
  return {
    INFISICAL_BASE_URL: 'https://infisical.test',
    INFISICAL_ENV: 'prod',
    INFISICAL_APP_PROJECT_ID: 'app-project',
    INFISICAL_APP_CLIENT_ID: 'app-client',
    INFISICAL_APP_CLIENT_SECRET: 'app-secret',
    INFISICAL_SHARED_PROJECT_ID: 'shared-project',
    INFISICAL_SHARED_CLIENT_ID: 'shared-client',
    INFISICAL_SHARED_CLIENT_SECRET: 'shared-secret',
    ...extra,
  } as Env;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Infisical runtime secret resolver', () => {
  it('merges shared then app secrets, with app overriding shared', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/api/v1/auth/universal-auth/login')) {
          const body = JSON.parse(String(init?.body || '{}')) as { clientId?: string };
          return Response.json({ accessToken: body.clientId === 'shared-client' ? 'shared-token' : 'app-token' });
        }
        if (url.includes('/api/v3/secrets/raw')) {
          const u = new URL(url);
          const workspaceId = u.searchParams.get('workspaceId');
          return Response.json({
            secrets:
              workspaceId === 'shared-project'
                ? [
                    { secretKey: 'FMP_API_KEY', secretValue: 'shared-fmp' },
                    { secretKey: 'MASSIVE_API_KEY', secretValue: 'shared-massive' },
                  ]
                : [{ secretKey: 'FMP_API_KEY', secretValue: 'app-fmp' }],
          });
        }
        return new Response('not found', { status: 404 });
      }),
    );

    const e = env({ INFISICAL_APP_PROJECT_ID: 'app-project-a' });
    await refreshSecrets(e);
    expect(await resolveSecret(e, 'FMP_API_KEY')).toEqual({ value: 'app-fmp', source: 'infisical' });
    expect(await resolveSecret(e, 'MASSIVE_API_KEY')).toEqual({ value: 'shared-massive', source: 'infisical' });
  });

  it('falls back to env during migration when Infisical does not provide a key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/api/v1/auth/universal-auth/login')) return Response.json({ accessToken: 'token' });
        if (url.includes('/api/v3/secrets/raw')) return Response.json({ secrets: [] });
        return new Response('not found', { status: 404 });
      }),
    );

    const e = env({ INFISICAL_APP_PROJECT_ID: 'app-project-b', FMP_API_KEY: 'env-fmp' });
    expect(await resolveSecret(e, 'FMP_API_KEY')).toEqual({ value: 'env-fmp', source: 'env' });
  });

  it('can disable env fallback after cutover', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/api/v1/auth/universal-auth/login')) return Response.json({ accessToken: 'token' });
        if (url.includes('/api/v3/secrets/raw')) return Response.json({ secrets: [] });
        return new Response('not found', { status: 404 });
      }),
    );

    const e = env({
      INFISICAL_APP_PROJECT_ID: 'app-project-c',
      INFISICAL_ALLOW_ENV_FALLBACK: 'false',
      FMP_API_KEY: 'env-fmp',
    });
    expect(await resolveSecret(e, 'FMP_API_KEY')).toEqual({ source: 'missing' });
  });

  it('does not use the KV cache without strong encryption secret material', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/api/v1/auth/universal-auth/login')) return Response.json({ accessToken: 'token' });
        if (url.includes('/api/v3/secrets/raw')) {
          return Response.json({ secrets: [{ secretKey: 'FMP_API_KEY', secretValue: 'infisical-fmp' }] });
        }
        return new Response('not found', { status: 404 });
      }),
    );
    const kv = {
      get: vi.fn(async () => {
        throw new Error('should not read weakly encrypted KV cache');
      }),
      put: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    };

    const e = env({
      INFISICAL_APP_PROJECT_ID: 'app-project-weak-kv',
      INFISICAL_APP_CLIENT_SECRET: 'short-secret',
      INFISICAL_SHARED_CLIENT_SECRET: 'short-shared',
      ADMIN_TOKEN: 'short-admin',
      CONFIG_KV: kv as unknown as KVNamespace,
    });

    expect(await resolveSecret(e, 'FMP_API_KEY')).toEqual({ value: 'infisical-fmp', source: 'infisical' });
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });
});
