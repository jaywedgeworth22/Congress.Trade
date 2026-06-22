import { describe, it, expect } from 'vitest';
import { issueMagicToken, consumeMagicToken, magicLinkEmail } from '../magic';
import type { Env } from '../../shared/types';

function fakeEnv() {
  const m = new Map<string, string>();
  const env = {
    CONFIG_KV: {
      get: async (k: string) => (m.has(k) ? m.get(k)! : null),
      put: async (k: string, v: string) => {
        m.set(k, v);
      },
      delete: async (k: string) => {
        m.delete(k);
      },
    },
  } as unknown as Env;
  return { env, m };
}

describe('magic-link tokens', () => {
  it('round-trips issue -> consume, stores only a hash + lowercased email, single-use', async () => {
    const { env, m } = fakeEnv();
    const token = await issueMagicToken(env, 'User@Example.com');
    // Stored under a hash key (not the raw token); email lowercased.
    expect(m.has('magic:' + token)).toBe(false);
    expect([...m.values()]).toContain('user@example.com');
    expect(await consumeMagicToken(env, token)).toBe('user@example.com');
    // Consumed -> gone (single use).
    expect(await consumeMagicToken(env, token)).toBeNull();
  });

  it('returns null for an unknown token', async () => {
    const { env } = fakeEnv();
    expect(await consumeMagicToken(env, 'deadbeef')).toBeNull();
  });
});

describe('magicLinkEmail', () => {
  it('embeds the verify URL in html + text', () => {
    const url = 'https://congress.trade/auth/magic/verify?token=abc';
    const mail = magicLinkEmail(url);
    expect(mail.html).toContain(url);
    expect(mail.text).toContain(url);
    expect(mail.subject).toMatch(/sign-in/i);
  });
});
