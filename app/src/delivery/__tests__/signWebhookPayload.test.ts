/**
 * src/delivery/__tests__/signWebhookPayload.test.ts
 *
 * HMAC-SHA256 signing tests for outbound webhooks. No network: we only exercise
 * signWebhookPayload, which uses WebCrypto (crypto.subtle), available in the
 * Workers runtime and in the Node test runtime (Node 20+).
 *
 * The first case asserts against a WIDELY-PUBLISHED known vector:
 *   HMAC-SHA256(key="key", msg="The quick brown fox jumps over the lazy dog")
 *     = f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8
 * so a regression in the encoder/hex/keying is caught deterministically.
 */

import { describe, it, expect } from 'vitest';
import { signWebhookPayload, signWebhookPayloadV1, verifyWebhookSignatureV1 } from '../webhook.ts';
import type { Env } from '../../shared/types.ts';

/** Minimal Env stand-in carrying only the signing key the function reads. */
function envWith(signingKey?: string): Env {
  return { WEBHOOK_SIGNING_KEY: signingKey } as unknown as Env;
}

describe('signWebhookPayload', () => {
  it('matches the published HMAC-SHA256 test vector (explicit secret)', async () => {
    const sig = await signWebhookPayload(
      envWith(),
      'The quick brown fox jumps over the lazy dog',
      'key',
    );
    expect(sig).toBe('f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
  });

  it('is lowercase hex of length 64 (32-byte digest)', async () => {
    const sig = await signWebhookPayload(envWith('whatever'), '{"a":1}');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it('prefers the per-subscription secret over the env signing key', async () => {
    const withSecret = await signWebhookPayload(envWith('ENV_KEY'), 'body', 'PER_SUB_SECRET');
    const expectedWithSecret = await signWebhookPayload(envWith(undefined), 'body', 'PER_SUB_SECRET');
    // Same body + same effective key => identical signature, regardless of env key.
    expect(withSecret).toBe(expectedWithSecret);
  });

  it('falls back to WEBHOOK_SIGNING_KEY when no secret is provided', async () => {
    const viaEnv = await signWebhookPayload(envWith('ENV_KEY'), 'body');
    const viaExplicit = await signWebhookPayload(envWith(undefined), 'body', 'ENV_KEY');
    expect(viaEnv).toBe(viaExplicit);
  });

  it('produces different signatures for different bodies', async () => {
    const a = await signWebhookPayload(envWith('k'), 'bodyA');
    const b = await signWebhookPayload(envWith('k'), 'bodyB');
    expect(a).not.toBe(b);
  });

  it('signs a realistic trade.new payload deterministically', async () => {
    const body = JSON.stringify({
      event: 'trade.new',
      transaction: { id: 'tx_1' },
      deliveredAt: '2026-06-20T00:00:00.000Z',
    });
    const s1 = await signWebhookPayload(envWith(), body, 'test_secret_key');
    const s2 = await signWebhookPayload(envWith(), body, 'test_secret_key');
    expect(s1).toBe(s2);
    expect(s1).toBe('084a8ddcb230d6932012a3a66489d5694b9223c13052a7a334ce288448812c28');
  });
});

/**
 * Replay protection (CT-AUD-P1-16).
 *
 * The legacy `X-Signature` covers the request body ALONE. A recipient that
 * verifies it cannot tell a replay from a fresh delivery and cannot bound how
 * long a captured request stays dangerous — it is valid forever. v1 binds a
 * timestamp into the signed material so the recipient can enforce a window.
 */
describe('signWebhookPayloadV1 / verifyWebhookSignatureV1', () => {
  const env = { WEBHOOK_SIGNING_KEY: 'worker-key' } as unknown as Env;
  const body = JSON.stringify({ txId: 'tx-1', ticker: 'MSFT' });
  const now = 1_785_600_000;

  it('signs the timestamp together with the body, not the body alone', async () => {
    const a = await signWebhookPayloadV1(env, now, body, 'sub-secret');
    const b = await signWebhookPayloadV1(env, now + 1, body, 'sub-secret');
    expect(a).not.toBe(b);
    // And it is genuinely a different value from the legacy body-only scheme.
    expect(a).not.toBe(await signWebhookPayload(env, body, 'sub-secret'));
  });

  it('accepts a freshly signed delivery', async () => {
    const sig = await signWebhookPayloadV1(env, now, body, 'sub-secret');
    await expect(
      verifyWebhookSignatureV1(env, `t=${now},v1=${sig}`, body, 'sub-secret', now),
    ).resolves.toBe(true);
  });

  it('rejects a replay once the acceptance window has passed', async () => {
    const sig = await signWebhookPayloadV1(env, now, body, 'sub-secret');
    const header = `t=${now},v1=${sig}`;
    // Still inside the window.
    await expect(
      verifyWebhookSignatureV1(env, header, body, 'sub-secret', now + 299),
    ).resolves.toBe(true);
    // Past it — this is the whole point of the change.
    await expect(
      verifyWebhookSignatureV1(env, header, body, 'sub-secret', now + 301),
    ).resolves.toBe(false);
  });

  it('rejects a far-future timestamp, which would extend a capture’s life', async () => {
    const future = now + 10_000;
    const sig = await signWebhookPayloadV1(env, future, body, 'sub-secret');
    await expect(
      verifyWebhookSignatureV1(env, `t=${future},v1=${sig}`, body, 'sub-secret', now),
    ).resolves.toBe(false);
  });

  it('rejects a tampered body, a tampered timestamp, and a wrong secret', async () => {
    const sig = await signWebhookPayloadV1(env, now, body, 'sub-secret');
    await expect(
      verifyWebhookSignatureV1(env, `t=${now},v1=${sig}`, body + ' ', 'sub-secret', now),
    ).resolves.toBe(false);
    // Moving t invalidates the signature rather than sliding the window.
    await expect(
      verifyWebhookSignatureV1(env, `t=${now + 5},v1=${sig}`, body, 'sub-secret', now + 5),
    ).resolves.toBe(false);
    await expect(
      verifyWebhookSignatureV1(env, `t=${now},v1=${sig}`, body, 'other-secret', now),
    ).resolves.toBe(false);
  });

  it('rejects malformed headers instead of throwing', async () => {
    for (const header of ['', 'garbage', 't=abc,v1=deadbeef', `t=${now}`, 'v1=deadbeef']) {
      await expect(
        verifyWebhookSignatureV1(env, header, body, 'sub-secret', now),
      ).resolves.toBe(false);
    }
  });
});
