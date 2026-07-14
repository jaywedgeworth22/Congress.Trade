/**
 * src/auth/google.ts
 * Google OAuth 2.0 (Authorization Code) for "Sign in with Google". We use the
 * OpenID userinfo endpoint with the access token rather than verifying the
 * id_token locally, which keeps the flow dependency-free.
 */

import type { Env } from '../shared/types';
import type { GoogleProfile } from './users';
import { resolveSecrets } from '../secrets/infisical';
import { trackedFetch } from '../shared/thirdPartyTelemetry';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

/** Build the Google consent-screen URL to redirect the user to. */
export async function buildGoogleAuthUrl(env: Env, redirectUri: string, state: string): Promise<string> {
  const { GOOGLE_OAUTH_CLIENT_ID: clientId } = await resolveSecrets(env, ['GOOGLE_OAUTH_CLIENT_ID']);
  if (!clientId) throw new Error('GOOGLE_OAUTH_CLIENT_ID not configured');
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });
  return `${AUTH_ENDPOINT}?${p.toString()}`;
}

interface TokenResponse {
  access_token?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

/** Exchange an authorization code for an access token. */
export async function exchangeGoogleCode(
  env: Env,
  code: string,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const { GOOGLE_OAUTH_CLIENT_ID: clientId, GOOGLE_OAUTH_CLIENT_SECRET: clientSecret } = await resolveSecrets(env, [
    'GOOGLE_OAUTH_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET',
  ]);
  if (!clientId || !clientSecret) throw new Error('Google OAuth not configured');
  const res = await trackedFetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  }, { service: 'oauth', operation: 'exchange-code' }, fetchImpl);
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !body.access_token) {
    throw new Error(`google token exchange failed: ${body.error || `HTTP ${res.status}`}`);
  }
  return body.access_token;
}

interface UserInfo {
  sub?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  picture?: string;
}

/** Fetch the authenticated user's profile with an access token. */
export async function fetchGoogleProfile(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleProfile> {
  const res = await trackedFetch(USERINFO_ENDPOINT, {
    headers: { authorization: `Bearer ${accessToken}` },
  }, { service: 'oauth', operation: 'fetch-user-profile' }, fetchImpl);
  if (!res.ok) throw new Error(`google userinfo failed: HTTP ${res.status}`);
  const u = (await res.json()) as UserInfo;
  if (!u.sub || !u.email) throw new Error('google userinfo missing sub/email');
  return {
    sub: u.sub,
    email: u.email,
    emailVerified: u.email_verified === true || u.email_verified === 'true',
    name: u.name ?? null,
    picture: u.picture ?? null,
  };
}
