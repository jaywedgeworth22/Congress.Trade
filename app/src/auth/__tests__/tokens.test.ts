import { describe, it, expect } from 'vitest';
import { constantTimeEqual, randomToken, sha256Hex } from '../tokens';

describe('randomToken', () => {
  it('returns lowercase hex of the requested byte length and is unique', () => {
    const a = randomToken(32);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(randomToken(16)).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(randomToken(32));
  });
});

describe('sha256Hex', () => {
  it('matches the known SHA-256("abc") vector', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('constantTimeEqual', () => {
  it('accepts equal strings and rejects different strings', async () => {
    await expect(constantTimeEqual('Bearer secret', 'Bearer secret')).resolves.toBe(true);
    await expect(constantTimeEqual('Bearer secret', 'Bearer nope')).resolves.toBe(false);
  });

  it('rejects different lengths after fixed-size digest comparison', async () => {
    await expect(constantTimeEqual('secret', 'secret-extra')).resolves.toBe(false);
  });
});
