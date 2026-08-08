import { describe, it, expect } from 'vitest';
import { verifyAppleSignedJws, AppleJwsVerificationError } from '../appleJws.ts';
import { parseCertificate } from '../appleCrypto.ts';
import { APPLE_ROOT_CA_G3_DER_B64 } from '../appleRootCert.ts';
import { buildAppleLikeChain, signAppleJws, type AppleLikeChain } from './appleCertFixtures.ts';

const FIXED_NOW = Date.parse('2025-06-01T00:00:00Z');

async function freshChain(): Promise<AppleLikeChain> {
  return buildAppleLikeChain({ notBefore: '2024-01-01T00:00:00Z', notAfter: '2034-01-01T00:00:00Z' });
}

describe('verifyAppleSignedJws', () => {
  it('accepts a well-formed chain anchored to the injected pinned root and returns the payload', async () => {
    const chain = await freshChain();
    const payload = { transactionId: 'tx-1', productId: 'trade.congress.premium.monthly' };
    const jws = await signAppleJws(chain, payload);

    const decoded = await verifyAppleSignedJws(jws, { pinnedRootB64: chain.root.b64, now: FIXED_NOW });
    expect(decoded).toEqual(payload);
  }, 15_000);

  it('accepts a chain that includes the root itself in x5c (self-signature anchor check)', async () => {
    const chain = await freshChain();
    const jws = await signAppleJws(
      chain,
      { hello: 'world' },
      { x5c: [chain.leaf.b64, chain.intermediate.b64, chain.root.b64] },
    );
    const decoded = await verifyAppleSignedJws(jws, { pinnedRootB64: chain.root.b64, now: FIXED_NOW });
    expect(decoded).toEqual({ hello: 'world' });
  }, 15_000);

  it('rejects when the chain does not anchor to the pinned root (wrong pin)', async () => {
    const chain = await freshChain();
    const otherChain = await freshChain(); // different root entirely
    const jws = await signAppleJws(chain, { x: 1 });
    await expect(
      verifyAppleSignedJws(jws, { pinnedRootB64: otherChain.root.b64, now: FIXED_NOW }),
    ).rejects.toThrow(AppleJwsVerificationError);
  }, 20_000);

  it('rejects a tampered payload (signature no longer matches)', async () => {
    const chain = await freshChain();
    const jws = await signAppleJws(chain, { amount: 5 });
    const [h, p, s] = jws.split('.');
    const tamperedPayload = btoa(JSON.stringify({ amount: 999999 }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const tampered = `${h}.${tamperedPayload}.${s}`;
    await expect(
      verifyAppleSignedJws(tampered, { pinnedRootB64: chain.root.b64, now: FIXED_NOW }),
    ).rejects.toThrow(AppleJwsVerificationError);
  }, 15_000);

  it('rejects when a certificate in the chain is expired relative to `now`', async () => {
    const chain = await buildAppleLikeChain({ notBefore: '2020-01-01T00:00:00Z', notAfter: '2020-06-01T00:00:00Z' });
    const jws = await signAppleJws(chain, { ok: true });
    const wayLater = Date.parse('2026-01-01T00:00:00Z');
    await expect(
      verifyAppleSignedJws(jws, { pinnedRootB64: chain.root.b64, now: wayLater }),
    ).rejects.toThrow(/expired|not yet valid/);
  }, 15_000);

  it('rejects a non-ES256 alg header', async () => {
    const chain = await freshChain();
    const jws = await signAppleJws(chain, { x: 1 }, { alg: 'HS256' });
    await expect(
      verifyAppleSignedJws(jws, { pinnedRootB64: chain.root.b64, now: FIXED_NOW }),
    ).rejects.toThrow(/alg/);
  }, 15_000);

  it('rejects malformed JWS shapes', async () => {
    await expect(verifyAppleSignedJws('not-a-jws')).rejects.toThrow(AppleJwsVerificationError);
    await expect(verifyAppleSignedJws('a.b')).rejects.toThrow(AppleJwsVerificationError);
    await expect(verifyAppleSignedJws('')).rejects.toThrow(AppleJwsVerificationError);
  });

  it('rejects a chain with a broken link (intermediate not actually signed by root)', async () => {
    const chainA = await freshChain();
    const chainB = await freshChain();
    // Splice chain B's intermediate into chain A's leaf-signed-by-A-intermediate JWS's x5c,
    // so leaf(A) -> claims issuer intermediate(B), which never signed it.
    const jws = await signAppleJws(chainA, { x: 1 }, { x5c: [chainA.leaf.b64, chainB.intermediate.b64] });
    await expect(
      verifyAppleSignedJws(jws, { pinnedRootB64: chainA.root.b64, now: FIXED_NOW }),
    ).rejects.toThrow(AppleJwsVerificationError);
  }, 20_000);

  it('the embedded production Apple Root CA - G3 constant parses as a valid, currently-in-window EC cert', () => {
    const root = parseCertificate(
      Uint8Array.from(atob(APPLE_ROOT_CA_G3_DER_B64), (c) => c.charCodeAt(0)),
    );
    expect(root.spkiCurve).toBe('P-384');
    expect(root.notBefore.getTime()).toBeLessThan(Date.now());
    expect(root.notAfter.getTime()).toBeGreaterThan(Date.now());
  });
});
