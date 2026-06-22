import { describe, it, expect } from 'vitest';
import { createPacer } from '../pace';

describe('createPacer', () => {
  it('is a no-op when no cap is given (never sleeps)', async () => {
    for (const cap of [undefined, 0, -10]) {
      const pace = createPacer(cap as number | undefined);
      const t0 = Date.now();
      for (let i = 0; i < 5; i++) await pace();
      expect(Date.now() - t0).toBeLessThan(50);
    }
  });

  it('first call is immediate; subsequent calls are spaced by ~60000/maxPerMinute ms', async () => {
    const pace = createPacer(600); // 100ms min gap
    const t0 = Date.now();
    await pace(); // immediate
    expect(Date.now() - t0).toBeLessThan(50);
    await pace(); // waits ~100ms
    expect(Date.now() - t0).toBeGreaterThanOrEqual(90);
  });
});
