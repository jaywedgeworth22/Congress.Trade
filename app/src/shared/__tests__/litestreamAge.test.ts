import { describe, expect, it } from 'vitest';
import { readLocalLitestreamAge } from '../litestreamAge.ts';

describe('readLocalLitestreamAge', () => {
  it('returns unknown when the LTX dir is missing (Node tests have no Deno fs)', async () => {
    const result = await readLocalLitestreamAge('/tmp/ct-ltx-does-not-exist');
    expect(result.litestreamStatus).toBe('unknown');
    expect(result.litestreamAgeSeconds).toBeNull();
  });
});
