/**
 * src/ui/__tests__/routes.test.ts
 *
 * SEOSOCIAL-01 / SEOSOCIAL-03: robots.txt keeps the AI-crawler blocks and the
 * general `Disallow: /api/`, but re-opens the specific read-only render
 * paths the SPA needs so Googlebot/Bingbot can actually see rendered
 * content — and points crawlers at the new sitemap. `/sitemap.xml` is wired
 * through to the sitemap module and never 500s even with no DB.
 */

import { describe, expect, it } from 'vitest';
import { buildUiRouter } from '../routes.ts';
import { resetSitemapCacheForTests } from '../sitemap.ts';

describe('/robots.txt', () => {
  it('allows the read-only render paths the SPA needs under the general Disallow: /api/', async () => {
    const app = buildUiRouter();
    const res = await app.request('http://localhost/robots.txt', {}, {} as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const body = await res.text();

    const wildcardGroup = body.slice(0, body.indexOf('User-Agent: GPTBot'));
    expect(wildcardGroup).toContain('User-Agent: *');
    expect(wildcardGroup).toContain('Allow: /api/analytics/');
    expect(wildcardGroup).toContain('Allow: /api/transactions');
    expect(wildcardGroup).toContain('Allow: /api/photos/');
    expect(wildcardGroup).toContain('Allow: /api/logos/');
    expect(wildcardGroup).toContain('Allow: /api/feed.xml');
    // The general block stays — only the specific render paths are re-opened.
    expect(wildcardGroup).toContain('Disallow: /api/');
  });

  it('still blocks every AI/LLM crawler outright (unchanged policy)', async () => {
    const app = buildUiRouter();
    const res = await app.request('http://localhost/robots.txt', {}, {} as never);
    const body = await res.text();
    const aiGroup = body.slice(body.indexOf('User-Agent: GPTBot'));
    expect(aiGroup).toContain('User-Agent: GPTBot');
    expect(aiGroup).toContain('User-Agent: ClaudeBot');
    expect(aiGroup).toContain('User-Agent: anthropic-ai');
    expect(aiGroup.trim().endsWith('Disallow: /')).toBe(false); // Sitemap: line follows
    expect(aiGroup).toMatch(/Disallow: \/\s*\n\s*\nSitemap: /);
  });

  it('points crawlers at the sitemap', async () => {
    const app = buildUiRouter();
    const res = await app.request('http://localhost/robots.txt', {}, {} as never);
    const body = await res.text();
    expect(body).toContain('Sitemap: https://congress.trade/sitemap.xml');
  });
});

describe('/sitemap.xml', () => {
  it('serves a cached, valid XML sitemap even with no DB binding', async () => {
    resetSitemapCacheForTests();
    const app = buildUiRouter();
    const res = await app.request('http://localhost/sitemap.xml', {}, {} as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/xml');
    expect(res.headers.get('cache-control')).toContain('max-age=3600');
    const body = await res.text();
    expect(body).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(body).toContain('<loc>https://congress.trade/</loc>');
  });
});

describe('SEOSOCIAL-05: ?trade= permalinks get a real share card', () => {
  function dbEnv(row: Record<string, unknown> | null) {
    return {
      DB: {
        prepare: () => ({
          bind() {
            return this;
          },
          async first() {
            return row;
          },
        }),
      },
    } as never;
  }

  it('renders filer + verb + ticker + bracket + date from the joined transaction/filer row', async () => {
    const env = dbEnv({
      tx_type: 'B',
      ticker: 'nvda',
      asset_name: 'NVIDIA Corp',
      amount_min: 1_000_001,
      amount_max: 5_000_000,
      tx_date: '2026-08-05',
      filer_id: 'P000197',
      full_name: 'Nancy Pelosi',
      chamber: 'house',
      party: 'Democrat',
      state: 'CA',
      district: '11',
    });
    const app = buildUiRouter();
    const res = await app.request('http://localhost/?trade=aa349372-0000', {}, env);
    const html = await res.text();
    expect(html).toContain('content="Nancy Pelosi (D-CA-11) bought NVDA ($1m - $5m) · Aug 5, 2026"');
    expect(html).toContain('og-image-company.png');
  });

  it('falls back to the default card for an unresolved trade id (never 500s)', async () => {
    const env = dbEnv(null);
    const app = buildUiRouter();
    const res = await app.request('http://localhost/?trade=does-not-exist', {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('content="Congress.Trade"');
  });

  it('never throws when the DB query itself throws', async () => {
    const env = {
      DB: {
        prepare: () => ({
          bind() {
            return this;
          },
          async first() {
            throw new Error('D1 unavailable');
          },
        }),
      },
    } as never;
    const app = buildUiRouter();
    const res = await app.request('http://localhost/?trade=aa349372-0000', {}, env);
    expect(res.status).toBe(200);
  });
});
