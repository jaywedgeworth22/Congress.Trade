/**
 * src/ui/__tests__/appLinks.test.ts
 *
 * WEB half of iOS Universal Links (see src/ui/appLinks.ts). Confirms:
 *   - the AASA manifest is served at the exact path iOS fetches, as real
 *     JSON, with the exact App ID, matching member/ticker/trade/view, and
 *     with /auth/* excluded so ASWebAuthenticationSession sign-in survives.
 *   - the Smart App Banner meta tag is absent until an App Store id is
 *     configured, and appears once one is.
 */

import { describe, it, expect } from 'vitest';
import { buildUiRouter } from '../routes.ts';
import { AASA_JSON, appStoreBannerTag } from '../appLinks.ts';

describe('apple-app-site-association route', () => {
  it('serves the AASA manifest with no redirect, no auth, application/json', async () => {
    const app = buildUiRouter();
    const res = await app.request(
      'http://localhost/.well-known/apple-app-site-association',
      {},
      {} as never,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    // No auth challenge, no redirect status.
    expect(res.headers.get('location')).toBeNull();
  });

  it('body parses as JSON and matches the exported AASA_JSON constant exactly', async () => {
    const app = buildUiRouter();
    const res = await app.request(
      'http://localhost/.well-known/apple-app-site-association',
      {},
      {} as never,
    );
    const text = await res.text();
    expect(() => JSON.parse(text)).not.toThrow();
    expect(text).toBe(AASA_JSON);
  });

  it('declares the exact CC8UTF7ATG.trade.congress.ios App ID', async () => {
    const doc = JSON.parse(AASA_JSON);
    expect(doc.applinks.details[0].appIDs).toEqual(['CC8UTF7ATG.trade.congress.ios']);
  });

  it('matches member, ticker, trade, and view query components', () => {
    const doc = JSON.parse(AASA_JSON);
    const components: Array<Record<string, unknown>> = doc.applinks.details[0].components;
    for (const key of ['member', 'ticker', 'trade', 'view']) {
      const match = components.find(
        (c) => c['/'] === '/' && (c['?'] as Record<string, unknown> | undefined)?.[key] === '?*',
      );
      expect(match, `expected a component matching ?${key}=`).toBeTruthy();
    }
  });

  it('excludes /auth/* so ASWebAuthenticationSession sign-in keeps working', () => {
    const doc = JSON.parse(AASA_JSON);
    const components: Array<Record<string, unknown>> = doc.applinks.details[0].components;
    const authExclude = components.find((c) => c['/'] === '/auth/*');
    expect(authExclude).toBeTruthy();
    expect(authExclude?.exclude).toBe(true);
  });

  it('excludes /api/* so the JSON API is never captured as a universal link', () => {
    const doc = JSON.parse(AASA_JSON);
    const components: Array<Record<string, unknown>> = doc.applinks.details[0].components;
    const apiExclude = components.find((c) => c['/'] === '/api/*');
    expect(apiExclude).toBeTruthy();
    expect(apiExclude?.exclude).toBe(true);
  });

  it('does not serve a legacy unprefixed root-level copy', async () => {
    const app = buildUiRouter();
    const res = await app.request('http://localhost/apple-app-site-association', {}, {} as never);
    expect(res.status).toBe(404);
  });
});

describe('Smart App Banner meta tag', () => {
  it('appStoreBannerTag returns null when IOS_APP_STORE_ID is unset', () => {
    expect(appStoreBannerTag({} as never)).toBeNull();
  });

  it('appStoreBannerTag returns null for a non-numeric value', () => {
    expect(appStoreBannerTag({ IOS_APP_STORE_ID: 'not-a-real-id' } as never)).toBeNull();
  });

  it('appStoreBannerTag returns the meta tag for a configured numeric id', () => {
    const tag = appStoreBannerTag({ IOS_APP_STORE_ID: '1234567890' } as never);
    expect(tag).toBe('<meta name="apple-itunes-app" content="app-id=1234567890" />');
  });

  it('the served dashboard HTML omits the banner meta when no id is configured', async () => {
    const app = buildUiRouter();
    const html = await (await app.request('http://localhost/', {}, {} as never)).text();
    expect(html).not.toContain('apple-itunes-app');
  });

  it('the served dashboard HTML includes the banner meta once an id is configured', async () => {
    const app = buildUiRouter();
    const html = await (
      await app.request('http://localhost/', {}, { IOS_APP_STORE_ID: '1234567890' } as never)
    ).text();
    expect(html).toContain('<meta name="apple-itunes-app" content="app-id=1234567890" />');
  });

  it('the /admin entry point also gets the banner meta once configured', async () => {
    const app = buildUiRouter();
    const html = await (
      await app.request('http://localhost/admin', {}, { IOS_APP_STORE_ID: '1234567890' } as never)
    ).text();
    expect(html).toContain('<meta name="apple-itunes-app" content="app-id=1234567890" />');
  });
});
