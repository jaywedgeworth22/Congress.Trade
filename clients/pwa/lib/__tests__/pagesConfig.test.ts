import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Cloudflare Pages configuration', () => {
  it('uses a valid explicit Functions route manifest', () => {
    const routes = JSON.parse(readFileSync('public/_routes.json', 'utf8')) as {
      version: number;
      include: string[];
      exclude: string[];
    };

    expect(routes).toEqual({
      version: 1,
      include: ['/api/*', '/auth/*'],
      exclude: [],
    });
  });
});
