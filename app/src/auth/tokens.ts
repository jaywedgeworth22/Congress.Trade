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
