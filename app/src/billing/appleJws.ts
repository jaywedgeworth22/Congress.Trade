/**
 * src/billing/appleJws.ts
 *
 * Verifies Apple-signed JWS payloads: StoreKit 2 `signedTransaction` /
 * `signedRenewalInfo` and App Store Server Notifications V2 `signedPayload`.
 * Both share the same envelope — a compact JWS whose protected header
 * carries `alg: "ES256"` and an `x5c` certificate chain (leaf first,
 * base64-DER per RFC 7515 §4.1.6). Apple does not include the root in `x5c`;
 * the topmost certificate the peer supplies is verified directly against our
 * pinned Apple Root CA - G3 public key (appleRootCert.ts) — no network call,
 * and no trust is placed in anything beyond what chains to that pin.
 */

import { parseCertificate, verifyCertSignedBy, type ParsedCert } from './appleCrypto.ts';
import { APPLE_ROOT_CA_G3_DER_B64 } from './appleRootCert.ts';

const MAX_CHAIN_LENGTH = 5;

export class AppleJwsVerificationError extends Error {}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  return b64ToBytes(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
}

interface JwsHeader {
  alg?: string;
  x5c?: string[];
}

export interface VerifyAppleJwsOptions {
  /** Override the pinned root's DER bytes (base64) — test injection only; production always uses the embedded Apple root. */
  pinnedRootB64?: string;
  /** Epoch ms used for certificate validity-window checks. Defaults to Date.now(). */
  now?: number;
}

function parseChain(x5c: string[]): ParsedCert[] {
  try {
    return x5c.map((certB64) => parseCertificate(b64ToBytes(certB64)));
  } catch (err) {
    throw new AppleJwsVerificationError(`malformed certificate in x5c chain: ${(err as Error).message}`);
  }
}

function assertCertsInWindow(certs: ParsedCert[], nowMs: number): void {
  for (const cert of certs) {
    if (nowMs < cert.notBefore.getTime() || nowMs > cert.notAfter.getTime()) {
      throw new AppleJwsVerificationError('a certificate in the chain is expired or not yet valid');
    }
  }
}

/**
 * Verify an Apple ES256 x5c-chained JWS end to end and return the decoded
 * JSON payload. Throws {@link AppleJwsVerificationError} on any failure —
 * malformed input, an unanchored/broken chain, an expired certificate, or an
 * invalid signature. Never returns a payload without a fully verified chain.
 */
export async function verifyAppleSignedJws<T = unknown>(
  jws: string,
  opts: VerifyAppleJwsOptions = {},
): Promise<T> {
  const trimmed = typeof jws === 'string' ? jws.trim() : '';
  if (trimmed.length < 40 || trimmed.length > 200_000) {
    throw new AppleJwsVerificationError('invalid JWS length');
  }
  const parts = trimmed.split('.');
  if (parts.length !== 3) throw new AppleJwsVerificationError('malformed JWS: expected 3 dot-separated parts');
  const [headerB64, payloadB64, sigB64] = parts;

  let header: JwsHeader;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(headerB64))) as JwsHeader;
  } catch {
    throw new AppleJwsVerificationError('malformed JWS header');
  }
  if (header.alg !== 'ES256') {
    throw new AppleJwsVerificationError(`unsupported JWS alg ${String(header.alg)}; only ES256 is accepted`);
  }
  const x5c = header.x5c;
  if (!Array.isArray(x5c) || x5c.length === 0 || x5c.length > MAX_CHAIN_LENGTH) {
    throw new AppleJwsVerificationError('missing or invalid x5c certificate chain');
  }
  if (!x5c.every((c) => typeof c === 'string' && c.length > 0)) {
    throw new AppleJwsVerificationError('x5c chain entries must be non-empty strings');
  }

  const chain = parseChain(x5c);
  const nowMs = opts.now ?? Date.now();
  assertCertsInWindow(chain, nowMs);

  let root: ParsedCert;
  try {
    root = parseCertificate(b64ToBytes(opts.pinnedRootB64 ?? APPLE_ROOT_CA_G3_DER_B64));
  } catch (err) {
    throw new AppleJwsVerificationError(`invalid pinned root certificate: ${(err as Error).message}`);
  }
  if (nowMs < root.notBefore.getTime() || nowMs > root.notAfter.getTime()) {
    throw new AppleJwsVerificationError('the pinned root certificate is outside its validity window');
  }

  // Anchor: the topmost certificate the peer supplied must be signed by our
  // pinned root's key. This holds whether Apple included the root itself in
  // x5c (a self-signature check against the pin — a no-op given the pin IS
  // that root) or stopped at the intermediate (the documented common case).
  const top = chain[chain.length - 1];
  const anchored = await verifyCertSignedBy(top, root.spkiRaw, root.spkiCurve);
  if (!anchored) throw new AppleJwsVerificationError('certificate chain does not anchor to the pinned Apple root');

  // Walk down: each certificate is signed by the NEXT certificate's key
  // (leaf <- intermediate <- ... ), i.e. x5c[i] signed by x5c[i+1].
  for (let i = 0; i < chain.length - 1; i++) {
    const issuer = chain[i + 1];
    const ok = await verifyCertSignedBy(chain[i], issuer.spkiRaw, issuer.spkiCurve);
    if (!ok) throw new AppleJwsVerificationError('certificate chain link failed to verify');
  }

  // Outer JWS signature: ES256 = ECDSA P-256 + SHA-256, raw r||s (RFC 7518 §3.4).
  const leaf = chain[0];
  if (leaf.spkiCurve !== 'P-256') {
    throw new AppleJwsVerificationError('leaf certificate is not a P-256 key required for ES256');
  }
  const leafKey = await crypto.subtle.importKey(
    'spki',
    leaf.spkiRaw as unknown as ArrayBuffer,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig = b64urlToBytes(sigB64);
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    leafKey,
    sig as unknown as ArrayBuffer,
    signingInput as unknown as ArrayBuffer,
  );
  if (!valid) throw new AppleJwsVerificationError('invalid JWS signature');

  try {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64))) as T;
  } catch {
    throw new AppleJwsVerificationError('malformed JWS payload');
  }
}
