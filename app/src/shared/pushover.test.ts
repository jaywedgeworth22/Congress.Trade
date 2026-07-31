import { describe, expect, it, vi } from 'vitest';
import type { Env } from './types.ts';
import { sendPushover } from './pushover.ts';

const env = {} as Env;

describe('sendPushover', () => {
  it('no-ops when credentials are missing', async () => {
    const fetchFn = vi.fn();
    const r = await sendPushover(env, { title: 't', message: 'm' }, { appToken: '', userKey: undefined }, fetchFn as unknown as typeof fetch);
    expect(r.sent).toBe(false);
    expect(r.reason).toContain('not configured');
    // Falls back to resolving secrets (env has no Infisical here) — still no fetch.
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('posts form-encoded token/user/title/message', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ status: 1 }), { status: 200 }));
    const r = await sendPushover(
      env,
      { title: 'R2 usage', message: 'line1\nline2', priority: 1 },
      { appToken: 'app-token', userKey: 'user-key' },
      fetchFn as unknown as typeof fetch,
    );
    expect(r).toEqual({ sent: true });
    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.pushover.net/1/messages.json');
    expect(init.method).toBe('POST');
    const params = new URLSearchParams(init.body as string);
    expect(params.get('token')).toBe('app-token');
    expect(params.get('user')).toBe('user-key');
    expect(params.get('title')).toBe('R2 usage');
    expect(params.get('message')).toBe('line1\nline2');
    expect(params.get('priority')).toBe('1');
  });

  it('reports HTTP failure', async () => {
    const fetchFn = vi.fn(async () => new Response('bad', { status: 400 }));
    const r = await sendPushover(env, { title: 't', message: 'm' }, { appToken: 'a', userKey: 'u' }, fetchFn as unknown as typeof fetch);
    expect(r.sent).toBe(false);
    expect(r.reason).toContain('HTTP 400');
  });

  it('reports Pushover API errors', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ status: 0, errors: ['user key is invalid'] }), { status: 200 }));
    const r = await sendPushover(env, { title: 't', message: 'm' }, { appToken: 'a', userKey: 'u' }, fetchFn as unknown as typeof fetch);
    expect(r.sent).toBe(false);
    expect(r.reason).toContain('user key is invalid');
  });

  it('never throws on network errors', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('socket hangup'); });
    const r = await sendPushover(env, { title: 't', message: 'm' }, { appToken: 'a', userKey: 'u' }, fetchFn as unknown as typeof fetch);
    expect(r.sent).toBe(false);
    expect(r.reason).toBe('socket hangup');
  });
});
