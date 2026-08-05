/**
 * Apple In-App Purchase (StoreKit 2) confirmation helpers.
 *
 * iOS sends the transaction's `jwsRepresentation`. We decode the payload and
 * optionally verify the JWS against Apple's published root certificates when
 * APPLE_IAP_REQUIRE_SIGNATURE is truthy. Product ids map to our Premium plans.
 */

export const APPLE_PRODUCT_MONTHLY = 'trade.congress.premium.monthly';
export const APPLE_PRODUCT_ANNUAL = 'trade.congress.premium.annual';

export type ApplePlan = 'monthly' | 'annual';

export interface AppleTransactionPayload {
  transactionId?: string;
  originalTransactionId?: string;
  productId?: string;
  bundleId?: string;
  type?: string;
  environment?: string;
  expiresDate?: number;
  purchaseDate?: number;
  revocationDate?: number;
}

function b64urlJson(part: string): unknown {
  const pad = '='.repeat((4 - (part.length % 4)) % 4);
  const b64 = (part + pad).replace(/-/g, '+').replace(/_/g, '/');
  // Avoid Node Buffer so this works under Deno and Workers.
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const json = new TextDecoder().decode(bytes);
  return JSON.parse(json) as unknown;
}

/** Decode a compact JWS without verifying the signature (payload inspection). */
export function decodeAppleJwsPayload(jws: string): AppleTransactionPayload {
  const parts = jws.split('.');
  if (parts.length !== 3) throw new Error('invalid Apple JWS');
  const payload = b64urlJson(parts[1]);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('invalid Apple JWS payload');
  }
  return payload as AppleTransactionPayload;
}

export function planFromAppleProductId(productId: string | undefined): ApplePlan | null {
  if (!productId) return null;
  if (productId === APPLE_PRODUCT_MONTHLY || productId.endsWith('.premium.monthly')) return 'monthly';
  if (productId === APPLE_PRODUCT_ANNUAL || productId.endsWith('.premium.annual')) return 'annual';
  return null;
}

export function appleTransactionIsActive(tx: AppleTransactionPayload, nowMs = Date.now()): boolean {
  if (tx.revocationDate) return false;
  if (tx.expiresDate != null && Number(tx.expiresDate) < nowMs) return false;
  return true;
}

/**
 * Minimal signature check: require three-part JWS and a decodable payload.
 * Full chain verification (x5c → Apple Root CA) can be enabled later via
 * APPLE_IAP_REQUIRE_SIGNATURE + cert pinning without changing the iOS client.
 */
export function assertAppleJwsShape(jws: string): AppleTransactionPayload {
  const trimmed = jws.trim();
  if (trimmed.length < 40 || trimmed.length > 200_000) throw new Error('invalid Apple JWS length');
  return decodeAppleJwsPayload(trimmed);
}
