import { describe, it, expect } from 'vitest';
import {
  normalizeLogoDisplay,
  getLogoDisplay,
  setLogoDisplay,
  DEFAULT_LOGO_DISPLAY,
} from '../settings';
import type { Env } from '../types';

// Minimal KV stub backed by a Map.
function fakeEnv(initial?: Record<string, string>): Env {
  const m = new Map<string, string>(Object.entries(initial || {}));
  return {
    CONFIG_KV: {
      get: async (k: string) => (m.has(k) ? m.get(k)! : null),
      put: async (k: string, v: string) => { m.set(k, v); },
    },
  } as unknown as Env;
}

describe('normalizeLogoDisplay', () => {
  it('passes through valid values', () => {
    expect(normalizeLogoDisplay('tile')).toBe('tile');
    expect(normalizeLogoDisplay('transparent')).toBe('transparent');
    expect(normalizeLogoDisplay('off')).toBe('off');
  });
  it('falls back to Plain (transparent) for anything invalid', () => {
    expect(normalizeLogoDisplay('bogus')).toBe('transparent');
    expect(normalizeLogoDisplay(undefined)).toBe('transparent');
    expect(normalizeLogoDisplay(42)).toBe('transparent');
    expect(DEFAULT_LOGO_DISPLAY).toBe('transparent');
  });
});

describe('getLogoDisplay / setLogoDisplay', () => {
  it('defaults to Plain when unset', async () => {
    expect(await getLogoDisplay(fakeEnv())).toBe('transparent');
  });
  it('reads a stored value', async () => {
    expect(await getLogoDisplay(fakeEnv({ 'ui:logo_display': 'tile' }))).toBe('tile');
  });
  it('normalizes a corrupt stored value', async () => {
    expect(await getLogoDisplay(fakeEnv({ 'ui:logo_display': 'nonsense' }))).toBe('transparent');
  });
  it('persists and returns the normalized value', async () => {
    const env = fakeEnv();
    expect(await setLogoDisplay(env, 'off')).toBe('off');
    expect(await getLogoDisplay(env)).toBe('off');
    expect(await setLogoDisplay(env, 'garbage')).toBe('transparent');
  });
  it('returns the default if KV throws', async () => {
    const env = { CONFIG_KV: { get: async () => { throw new Error('kv down'); } } } as unknown as Env;
    expect(await getLogoDisplay(env)).toBe('transparent');
  });
});
