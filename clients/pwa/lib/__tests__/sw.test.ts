/**
 * Service-worker cache-isolation tests (CT-AUD-006).
 *
 * The v1 worker wrote every successful same-origin GET — including
 * authenticated /api/client/v1/* responses — into Cache Storage, so an
 * account switch on a shared device could serve the previous account's
 * bootstrap/preferences from cache. These tests evaluate public/sw.js in a
 * simulated SW global scope and pin the fixed contract:
 *   - /api/ requests are network-only: never written to, never served from cache
 *   - only immutable public static assets are cached
 *   - the cache version is bumped so stale v1 caches are evicted on activate
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SW_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'public', 'sw.js',
);
const SW_SOURCE = readFileSync(SW_PATH, 'utf8');
const ORIGIN = 'https://congress.trade';

type Handler = (event: FakeFetchEvent) => void;

interface FakeRequest {
  url: string;
  method: string;
  mode?: string;
}

class FakeFetchEvent {
  request: FakeRequest;
  responsePromise: Promise<Response> | null = null;
  waited: Promise<unknown>[] = [];
  constructor(request: FakeRequest) {
    this.request = request;
  }
  respondWith(p: Promise<Response> | Response): void {
    this.responsePromise = Promise.resolve(p);
  }
  waitUntil(p: Promise<unknown>): void {
    this.waited.push(p);
  }
}

class FakeCache {
  store = new Map<string, Response>();
  async match(request: FakeRequest | string): Promise<Response | undefined> {
    return this.store.get(typeof request === 'string' ? new URL(request, ORIGIN).href : request.url);
  }
  async put(request: FakeRequest | string, response: Response): Promise<void> {
    this.store.set(typeof request === 'string' ? new URL(request, ORIGIN).href : request.url, response);
  }
  async addAll(paths: string[]): Promise<void> {
    for (const p of paths) this.store.set(new URL(p, ORIGIN).href, new Response('asset'));
  }
}

class FakeCacheStorage {
  caches = new Map<string, FakeCache>();
  async open(name: string): Promise<FakeCache> {
    if (!this.caches.has(name)) this.caches.set(name, new FakeCache());
    return this.caches.get(name)!;
  }
  async keys(): Promise<string[]> {
    return [...this.caches.keys()];
  }
  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name);
  }
  async match(request: FakeRequest | string): Promise<Response | undefined> {
    for (const cache of this.caches.values()) {
      const hit = await cache.match(request);
      if (hit) return hit;
    }
    return undefined;
  }
  /** Every URL currently present in any cache. */
  allKeys(): string[] {
    return [...this.caches.values()].flatMap((c) => [...c.store.keys()]);
  }
}

interface Harness {
  cacheStorage: FakeCacheStorage;
  handlers: Map<string, Handler>;
  fetchCalls: FakeRequest[];
  setNetwork(responder: (request: FakeRequest) => Promise<Response>): void;
  dispatchFetch(request: FakeRequest): Promise<{ response: Response | null; event: FakeFetchEvent }>;
  activate(): Promise<void>;
}

function loadServiceWorker(): Harness {
  const handlers = new Map<string, Handler>();
  const cacheStorage = new FakeCacheStorage();
  const fetchCalls: FakeRequest[] = [];
  let network: (request: FakeRequest) => Promise<Response> = async () => new Response('ok');

  const self = {
    location: { origin: ORIGIN },
    addEventListener(type: string, handler: Handler) {
      handlers.set(type, handler);
    },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  const fetchImpl = async (request: FakeRequest) => {
    fetchCalls.push(request);
    return network(request);
  };

  const run = new Function('self', 'caches', 'fetch', 'Response', 'URL', SW_SOURCE);
  run(self, cacheStorage, fetchImpl, Response, URL);

  return {
    cacheStorage,
    handlers,
    fetchCalls,
    setNetwork(responder) {
      network = responder;
    },
    async dispatchFetch(request) {
      const event = new FakeFetchEvent(request);
      handlers.get('fetch')!(event);
      const response = event.responsePromise ? await event.responsePromise : null;
      await Promise.all(event.waited);
      return { response, event };
    },
    async activate() {
      const event = new FakeFetchEvent({ url: ORIGIN, method: 'GET' });
      handlers.get('activate')!(event);
      await Promise.all(event.waited);
    },
  };
}

function apiRequest(path: string): FakeRequest {
  return { url: `${ORIGIN}${path}`, method: 'GET' };
}

describe('service worker cache isolation', () => {
  let sw: Harness;

  beforeEach(() => {
    sw = loadServiceWorker();
  });

  it('bumps the cache version past v1', () => {
    expect(SW_SOURCE).not.toMatch(/CACHE_PREFIX\}v1`/);
    expect(SW_SOURCE).toMatch(/CACHE_PREFIX\}v([2-9]|\d{2,})`/);
  });

  it('activate evicts the old v1 cache (and any polluted entries in it)', async () => {
    const stale = await sw.cacheStorage.open('congress-trade-shell-v1');
    await stale.put(apiRequest('/api/client/v1/bootstrap'), new Response('{"user":"account-a"}'));
    await sw.activate();
    expect(await sw.cacheStorage.keys()).not.toContain('congress-trade-shell-v1');
    expect(await sw.cacheStorage.match(apiRequest('/api/client/v1/bootstrap'))).toBeUndefined();
  });

  it('never writes /api/ responses to Cache Storage', async () => {
    sw.setNetwork(async () => new Response('{"user":"account-a"}', { status: 200 }));
    const { response } = await sw.dispatchFetch(apiRequest('/api/client/v1/bootstrap'));
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe('{"user":"account-a"}');
    expect(sw.cacheStorage.allKeys().filter((k) => k.includes('/api/'))).toEqual([]);
  });

  it('does not serve another account\'s data after logout/account switch', async () => {
    // Account A uses the app.
    sw.setNetwork(async () => new Response('{"user":"account-a"}'));
    await sw.dispatchFetch(apiRequest('/api/client/v1/bootstrap'));
    await sw.dispatchFetch(apiRequest('/api/client/v1/preferences'));

    // Account B signs in on the same device: responses must come from the
    // network, never from anything account A's session left behind.
    sw.setNetwork(async () => new Response('{"user":"account-b"}'));
    const { response } = await sw.dispatchFetch(apiRequest('/api/client/v1/bootstrap'));
    expect(await response?.text()).toBe('{"user":"account-b"}');

    // And if account B is offline, the API must fail closed (503), not fall
    // back to account A's cached payload.
    sw.setNetwork(async () => {
      throw new Error('offline');
    });
    const offline = await sw.dispatchFetch(apiRequest('/api/client/v1/bootstrap'));
    expect(offline.response?.status).toBe(503);
    expect(await offline.response?.text()).toBe('');
  });

  it('still caches immutable static assets (cache-first)', async () => {
    sw.setNetwork(async () => new Response('static-bundle'));
    const asset = apiRequest('/_next/static/chunks/main-abc123.js');
    const first = await sw.dispatchFetch(asset);
    expect(await first.response?.text()).toBe('static-bundle');
    expect(sw.fetchCalls).toHaveLength(1);

    // Second hit is served from cache without touching the network.
    sw.setNetwork(async () => {
      throw new Error('offline');
    });
    const second = await sw.dispatchFetch(asset);
    expect(await second.response?.text()).toBe('static-bundle');
    expect(sw.fetchCalls).toHaveLength(1);
  });

  it('does not cache HTML navigations and serves the offline fallback', async () => {
    sw.setNetwork(async () => new Response('<html>page</html>'));
    await sw.dispatchFetch({ url: `${ORIGIN}/`, method: 'GET', mode: 'navigate' });
    expect(sw.cacheStorage.allKeys()).toEqual([]);

    sw.setNetwork(async () => {
      throw new Error('offline');
    });
    const offline = await sw.dispatchFetch({ url: `${ORIGIN}/`, method: 'GET', mode: 'navigate' });
    expect(offline.response?.status).toBe(503);
    expect(await offline.response?.text()).toContain('Offline');
  });

  it('ignores non-GET requests entirely', async () => {
    const { response } = await sw.dispatchFetch({ url: `${ORIGIN}/api/client/v1/commands`, method: 'POST' });
    expect(response).toBeNull();
    expect(sw.fetchCalls).toHaveLength(0);
  });
});
