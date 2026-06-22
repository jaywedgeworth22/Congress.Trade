import { describe, it, expect } from 'vitest';
import { buildGoogleAuthUrl, exchangeGoogleCode, fetchGoogleProfile } from '../google';
import type { Env } from '../../shared/types';

const env = {
  GOOGLE_OAUTH_CLIENT_ID: 'cid',
  GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
} as unknown as Env;

describe('buildGoogleAuthUrl', () => {
  it('includes client_id, redirect_uri, scope, state, response_type', () => {
    const url = new URL(buildGoogleAuthUrl(env, 'https://app/cb', 'st8'));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app/cb');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('state')).toBe('st8');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('throws when the client id is missing', () => {
    expect(() => buildGoogleAuthUrl({} as unknown as Env, 'x', 's')).toThrow();
  });
});

describe('exchangeGoogleCode', () => {
  it('returns the access token on success', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ access_token: 'AT' }), { status: 200 })) as unknown as typeof fetch;
    expect(await exchangeGoogleCode(env, 'code', 'https://app/cb', fetchImpl)).toBe('AT');
  });

  it('throws on an error response', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })) as unknown as typeof fetch;
    await expect(exchangeGoogleCode(env, 'code', 'https://app/cb', fetchImpl)).rejects.toThrow(
      /invalid_grant/,
    );
  });
});

describe('fetchGoogleProfile', () => {
  it('maps userinfo to a GoogleProfile', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ sub: 's', email: 'A@B.com', email_verified: true, name: 'N', picture: 'P' }),
        { status: 200 },
      )) as unknown as typeof fetch;
    expect(await fetchGoogleProfile('AT', fetchImpl)).toEqual({
      sub: 's',
      email: 'A@B.com',
      emailVerified: true,
      name: 'N',
      picture: 'P',
    });
  });

  it('throws when sub/email are missing', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ sub: 's' }), { status: 200 })) as unknown as typeof fetch;
    await expect(fetchGoogleProfile('AT', fetchImpl)).rejects.toThrow();
  });
});
