import { describe, it, expect, beforeEach } from 'vitest';
import {
  b64urlToBytes,
  decodeJwt,
  parseEmailAllowlist,
  certsUrl,
  checkAccessClaims,
  verifyAccessJwt,
  _resetJwksCache,
  type AccessJwtPayload,
} from '../access';

const CRYPTO_TEST_TIMEOUT_MS = 15_000;

// --- helpers ---------------------------------------------------------------

function bytesToB64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function jsonToB64url(obj: unknown): string {
  return bytesToB64url(new TextEncoder().encode(JSON.stringify(obj)));
}

async function makeKeypair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
}

async function signJwt(payload: AccessJwtPayload, privateKey: CryptoKey, kid = 'k1', alg = 'RS256') {
  const header = jsonToB64url({ alg, kid, typ: 'JWT' });
  const body = jsonToB64url(payload);
  const signingInput = `${header}.${body}`;
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${bytesToB64url(new Uint8Array(sig))}`;
}

async function jwksFor(publicKey: CryptoKey, kid = 'k1'): Promise<Response> {
  const jwk = (await crypto.subtle.exportKey('jwk', publicKey)) as JsonWebKey;
  const full = { ...jwk, kid, alg: 'RS256', use: 'sig' };
  return new Response(JSON.stringify({ keys: [full] }), { status: 200 });
}

// --- pure helpers ----------------------------------------------------------

describe('b64urlToBytes / decodeJwt', () => {
  it('round-trips a JWT structure', () => {
    const token = `${jsonToB64url({ alg: 'RS256', kid: 'k1' })}.${jsonToB64url({
      email: 'a@b.com',
      aud: ['tag'],
    })}.${bytesToB64url(new Uint8Array([1, 2, 3]))}`;
    const d = decodeJwt(token);
    expect(d.header.kid).toBe('k1');
    expect(d.payload.email).toBe('a@b.com');
    expect(Array.from(d.signature)).toEqual([1, 2, 3]);
  });
  it('throws on malformed token', () => {
    expect(() => decodeJwt('not.a')).toThrow();
  });
  it('decodes base64url without padding', () => {
    expect(new TextDecoder().decode(b64urlToBytes(bytesToB64url(new TextEncoder().encode('hi'))))).toBe('hi');
  });
});

describe('parseEmailAllowlist', () => {
  it('splits, trims, lowercases, dedupes', () => {
    const s = parseEmailAllowlist(' A@B.com, c@d.com\n A@b.com ');
    expect([...s].sort()).toEqual(['a@b.com', 'c@d.com']);
  });
  it('returns empty set for undefined/empty', () => {
    expect(parseEmailAllowlist(undefined).size).toBe(0);
    expect(parseEmailAllowlist('   ').size).toBe(0);
  });
});

describe('certsUrl', () => {
  it('appends cloudflareaccess.com to a bare team name', () => {
    expect(certsUrl('myteam')).toBe('https://myteam.cloudflareaccess.com/cdn-cgi/access/certs');
  });
  it('uses a full hostname as-is and strips scheme/path', () => {
    expect(certsUrl('https://myteam.cloudflareaccess.com/foo')).toBe(
      'https://myteam.cloudflareaccess.com/cdn-cgi/access/certs',
    );
  });
});

describe('checkAccessClaims', () => {
  const allow = parseEmailAllowlist('me@x.com');
  const base = { aud: 'tag', allow, now: 1000 };
  it('accepts a good claim set', () => {
    expect(checkAccessClaims({ email: 'me@x.com', aud: ['tag'], exp: 2000 }, base)).toEqual({
      ok: true,
      email: 'me@x.com',
    });
  });
  it('rejects aud mismatch', () => {
    expect(checkAccessClaims({ email: 'me@x.com', aud: ['other'] }, base).reason).toBe('aud mismatch');
  });
  it('rejects expired (beyond leeway)', () => {
    expect(checkAccessClaims({ email: 'me@x.com', aud: 'tag', exp: 900 }, base).reason).toBe('token expired');
  });
  it('rejects an email not on the allowlist', () => {
    expect(checkAccessClaims({ email: 'evil@x.com', aud: 'tag', exp: 2000 }, base).reason).toBe(
      'email not allowed',
    );
  });
  it('rejects a missing email claim', () => {
    expect(checkAccessClaims({ aud: 'tag', exp: 2000 }, base).reason).toBe('no email claim');
  });
});

// --- full verification with a real signature -------------------------------

describe('verifyAccessJwt', () => {
  beforeEach(() => _resetJwksCache());
  const allow = parseEmailAllowlist('me@x.com');

  it('accepts a properly signed, allowlisted token', async () => {
    const kp = await makeKeypair();
    const token = await signJwt({ email: 'me@x.com', aud: ['tag'], exp: 4000 }, kp.privateKey);
    const res = await verifyAccessJwt(token, {
      aud: 'tag',
      allow,
      jwksUrl: 'https://t1.cloudflareaccess.com/cdn-cgi/access/certs',
      now: 1000,
      fetchImpl: async () => jwksFor(kp.publicKey),
    });
    expect(res).toEqual({ ok: true, email: 'me@x.com' });
  }, CRYPTO_TEST_TIMEOUT_MS);

  it('rejects a token signed by a different key (bad signature)', async () => {
    const signer = await makeKeypair();
    const attacker = await makeKeypair();
    const token = await signJwt({ email: 'me@x.com', aud: ['tag'], exp: 4000 }, attacker.privateKey);
    const res = await verifyAccessJwt(token, {
      aud: 'tag',
      allow,
      jwksUrl: 'https://t2.cloudflareaccess.com/cdn-cgi/access/certs',
      now: 1000,
      fetchImpl: async () => jwksFor(signer.publicKey), // published key != signer
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('bad signature');
  }, CRYPTO_TEST_TIMEOUT_MS);

  it('rejects an allowlist miss even with a valid signature', async () => {
    const kp = await makeKeypair();
    const token = await signJwt({ email: 'intruder@x.com', aud: ['tag'], exp: 4000 }, kp.privateKey);
    const res = await verifyAccessJwt(token, {
      aud: 'tag',
      allow,
      jwksUrl: 'https://t3.cloudflareaccess.com/cdn-cgi/access/certs',
      now: 1000,
      fetchImpl: async () => jwksFor(kp.publicKey),
    });
    expect(res).toEqual({ ok: false, reason: 'email not allowed' });
  }, CRYPTO_TEST_TIMEOUT_MS);

  it('rejects when no signing key matches the kid', async () => {
    const kp = await makeKeypair();
    const token = await signJwt({ email: 'me@x.com', aud: ['tag'], exp: 4000 }, kp.privateKey, 'unknown-kid');
    const res = await verifyAccessJwt(token, {
      aud: 'tag',
      allow,
      jwksUrl: 'https://t4.cloudflareaccess.com/cdn-cgi/access/certs',
      now: 1000,
      fetchImpl: async () => jwksFor(kp.publicKey, 'k1'),
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('no matching signing key');
  }, CRYPTO_TEST_TIMEOUT_MS);

  it('rejects a malformed token without fetching', async () => {
    let fetched = false;
    const res = await verifyAccessJwt('garbage', {
      aud: 'tag',
      allow,
      jwksUrl: 'https://t5.cloudflareaccess.com/cdn-cgi/access/certs',
      now: 1000,
      fetchImpl: async () => {
        fetched = true;
        return new Response('{}', { status: 200 });
      },
    });
    expect(res.ok).toBe(false);
    expect(fetched).toBe(false);
  });
});
