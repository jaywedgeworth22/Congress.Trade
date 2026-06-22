/**
 * src/admin/access.ts
 * Cloudflare Access (Zero Trust) identity verification for the admin surface.
 *
 * When an Access application fronts /api/admin/*, Cloudflare injects a signed
 * JWT in the `Cf-Access-Jwt-Assertion` header (and the authenticated email in
 * `Cf-Access-Authenticated-User-Email`). We verify the JWT's RS256 signature
 * against the team's public keys, check the `aud` (application tag) and `exp`,
 * and confirm the authenticated email is on the ADMIN_EMAILS allowlist.
 *
 * Why verify the signature instead of trusting the email header: the worker's
 * *.workers.dev URL is NOT behind Access, so a forged `Cf-Access-*` header on a
 * direct request must not authorize. Only Cloudflare Access can mint a JWT that
 * verifies against the team keys, so signature verification is what makes the
 * email allowlist trustworthy.
 */

export interface AccessJwtHeader {
  alg?: string;
  kid?: string;
}
export interface AccessJwtPayload {
  email?: string;
  aud?: string | string[];
  iss?: string;
  exp?: number;
  nbf?: number;
}
export interface Jwk {
  kid?: string;
  kty?: string;
  n?: string;
  e?: string;
  alg?: string;
  use?: string;
}
export interface Jwks {
  keys: Jwk[];
}
export interface AccessVerifyResult {
  ok: boolean;
  email?: string;
  reason?: string;
}

// base64url string -> bytes
export function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Split + decode a JWT WITHOUT verifying. Throws on malformed input. */
export function decodeJwt(token: string): {
  header: AccessJwtHeader;
  payload: AccessJwtPayload;
  signingInput: string;
  signature: Uint8Array;
} {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed jwt');
  const dec = (p: string) => JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
  return {
    header: dec(parts[0]) as AccessJwtHeader,
    payload: dec(parts[1]) as AccessJwtPayload,
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: b64urlToBytes(parts[2]),
  };
}

/** Parse a comma/space-separated allowlist into a lowercase Set. */
export function parseEmailAllowlist(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!raw) return out;
  for (const e of raw.split(/[,\s]+/)) {
    const t = e.trim().toLowerCase();
    if (t) out.add(t);
  }
  return out;
}

/** Build the JWKS certs URL from a team name or full hostname. */
export function certsUrl(teamDomain: string): string {
  const d = teamDomain.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const host = d.includes('.') ? d : `${d}.cloudflareaccess.com`;
  return `https://${host}/cdn-cgi/access/certs`;
}

/**
 * Pure claims check (no signature verification): validate aud, exp/nbf, and the
 * email allowlist. `now` is epoch seconds.
 */
export function checkAccessClaims(
  payload: AccessJwtPayload,
  opts: { aud: string; allow: Set<string>; now: number; leewaySec?: number },
): AccessVerifyResult {
  const leeway = opts.leewaySec ?? 60;
  const auds = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
  if (!auds.includes(opts.aud)) return { ok: false, reason: 'aud mismatch' };
  if (typeof payload.exp === 'number' && opts.now > payload.exp + leeway) {
    return { ok: false, reason: 'token expired' };
  }
  if (typeof payload.nbf === 'number' && opts.now + leeway < payload.nbf) {
    return { ok: false, reason: 'token not yet valid' };
  }
  const email = (payload.email ?? '').trim().toLowerCase();
  if (!email) return { ok: false, reason: 'no email claim' };
  if (!opts.allow.has(email)) return { ok: false, reason: 'email not allowed' };
  return { ok: true, email };
}

// --- JWKS cache (module-level; survives across requests in a warm isolate) --
interface CacheEntry {
  fetchedAtMs: number;
  keys: Map<string, CryptoKey>;
}
const jwksCache = new Map<string, CacheEntry>();
const JWKS_TTL_MS = 60 * 60 * 1000; // 1h

/** Test hook: clear the JWKS cache between cases. */
export function _resetJwksCache(): void {
  jwksCache.clear();
}

async function importRsaKey(jwk: Jwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
}

async function getSigningKey(
  jwksUrl: string,
  kid: string | undefined,
  fetchImpl: typeof fetch,
  nowMs: number,
): Promise<CryptoKey | null> {
  let entry = jwksCache.get(jwksUrl);
  const stale = !entry || nowMs - entry.fetchedAtMs > JWKS_TTL_MS;
  const missingKid = !!entry && kid != null && !entry.keys.has(kid);
  if (stale || missingKid) {
    const res = await fetchImpl(jwksUrl);
    if (res.ok) {
      const body = (await res.json()) as Jwks;
      const keys = new Map<string, CryptoKey>();
      for (const jwk of body.keys ?? []) {
        if (jwk.kty !== 'RSA' || !jwk.n || !jwk.e) continue;
        try {
          keys.set(jwk.kid ?? '', await importRsaKey(jwk));
        } catch {
          /* skip unusable key */
        }
      }
      entry = { fetchedAtMs: nowMs, keys };
      jwksCache.set(jwksUrl, entry);
    }
  }
  if (!entry) return null;
  if (kid != null && entry.keys.has(kid)) return entry.keys.get(kid) ?? null;
  // kid absent but exactly one key published -> unambiguous.
  if (kid == null && entry.keys.size === 1) return [...entry.keys.values()][0];
  return null;
}

export interface VerifyOptions {
  aud: string;
  allow: Set<string>;
  jwksUrl: string;
  now?: number; // epoch seconds (test injection)
  fetchImpl?: typeof fetch;
  leewaySec?: number;
}

/**
 * Full verification: decode, verify the RS256 signature against the team JWKS,
 * then validate claims + allowlist. Never throws — returns {ok:false,reason}.
 */
export async function verifyAccessJwt(token: string, opts: VerifyOptions): Promise<AccessVerifyResult> {
  let decoded: ReturnType<typeof decodeJwt>;
  try {
    decoded = decodeJwt(token);
  } catch {
    return { ok: false, reason: 'malformed jwt' };
  }
  if (decoded.header.alg !== 'RS256') return { ok: false, reason: 'unexpected alg' };

  const nowSec = opts.now ?? Math.floor(Date.now() / 1000);
  const fetchImpl = opts.fetchImpl ?? fetch;

  let key: CryptoKey | null;
  try {
    key = await getSigningKey(opts.jwksUrl, decoded.header.kid, fetchImpl, nowSec * 1000);
  } catch {
    return { ok: false, reason: 'jwks fetch failed' };
  }
  if (!key) return { ok: false, reason: 'no matching signing key' };

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    decoded.signature,
    new TextEncoder().encode(decoded.signingInput),
  );
  if (!valid) return { ok: false, reason: 'bad signature' };

  return checkAccessClaims(decoded.payload, {
    aud: opts.aud,
    allow: opts.allow,
    now: nowSec,
    leewaySec: opts.leewaySec,
  });
}
