/**
 * src/auth/tokens.ts
 * Small WebCrypto helpers for auth tokens (session ids, magic-link tokens,
 * OAuth state). Workers exposes Web Crypto globally — no deps.
 */

/** Cryptographically random token as a lowercase hex string (`bytes` of entropy). */
export function randomToken(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 of `input`, lowercase hex. Used to store only token *hashes* at rest. */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Compare two secret strings without short-circuiting on length or first
 * differing byte. Both values are hashed first so the comparison operates over
 * fixed-size digests and does not expose the raw token length.
 */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [aHash, bHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  const aa = new Uint8Array(aHash);
  const bb = new Uint8Array(bHash);
  let diff = aa.length ^ bb.length;
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i += 1) {
    diff |= (aa[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}
