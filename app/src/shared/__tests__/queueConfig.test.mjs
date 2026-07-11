import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function config(name) {
  return readFileSync(new URL(`../../../${name}`, import.meta.url), 'utf8');
}

describe('dead-letter consumer config parity', () => {
  it.each([
    ['wrangler.toml', 'congress-feed'],
    ['wrangler.preview.example.toml', 'congress-feed-preview'],
  ])('actively consumes both DLQs in %s', (name, prefix) => {
    const toml = config(name);
    for (const suffix of ['ingest-dlq', 'delivery-dlq']) {
      expect(toml).toMatch(new RegExp(`\\[\\[queues\\.consumers\\]\\]\\s+queue = "${prefix}-${suffix}"`));
    }
  });
});
