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
import { signWebhookPayload } from '../webhook';
import type { Env } from '../../shared/types';

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
