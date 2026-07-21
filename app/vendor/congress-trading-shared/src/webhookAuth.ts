/**
 * src/webhookAuth.ts
 */

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

export async function signCongressWebhook(body: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(body));
  return toHex(new Uint8Array(sigBuf));
}

/**
 * Verify a congress webhook signature.
 * Tolerates the optional "sha256=" prefix historically sent by Congress.Trade.
 */
export async function verifyCongressWebhookSignature(
  body: string,
  signatureHeader: string,
  secret: string
): Promise<boolean> {
  const expectedSig = await signCongressWebhook(body, secret);
  
  let actualSig = signatureHeader.trim().toLowerCase();
  if (actualSig.startsWith('sha256=')) {
    actualSig = actualSig.slice(7);
  }

  if (expectedSig.length !== actualSig.length) return false;
  
  let isEqual = true;
  for (let i = 0; i < expectedSig.length; i++) {
    if (expectedSig[i] !== actualSig[i]) isEqual = false;
  }
  
  return isEqual;
}
