import { describe, expect, it, vi } from 'vitest';
import { localWebhookTargetsAllowed, validatePublicWebhookTarget } from '../webhookTarget';

function dnsFetch(a: string[] = [], aaaa: string[] = []) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const type = new URL(String(input)).searchParams.get('type');
    const values = type === 'A' ? a : aaaa;
    return Response.json({
      Status: 0,
      Answer: values.map((data) => ({ type: data.includes(':') ? 28 : 1, data })),
    });
  });
}

describe('public webhook destination validation', () => {
  it('accepts a hostname only when every resolved address is public', async () => {
    const fetchImpl = dnsFetch(['93.184.216.34'], ['2606:2800:220:1:248:1893:25c8:1946']);
    expect(await validatePublicWebhookTarget('https://example.com/hook', { fetchImpl })).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects DNS rebinding/private answers', async () => {
    const fetchImpl = dnsFetch(['93.184.216.34', '169.254.169.254']);
    expect(await validatePublicWebhookTarget('https://example.com/hook', { fetchImpl })).toContain('private');
  });

  it('fails closed on DNS errors or no address records', async () => {
    expect(await validatePublicWebhookTarget('https://example.com/hook', { fetchImpl: dnsFetch() })).toContain('did not resolve');
    const failed = vi.fn(async () => new Response('down', { status: 503 }));
    expect(await validatePublicWebhookTarget('https://example.com/hook', { fetchImpl: failed })).toContain('DNS validation failed');
  });

  it('allows localhost only under the explicit local-development policy', async () => {
    expect(await validatePublicWebhookTarget('http://localhost:8788/hook', { allowLocalhost: true })).toBeNull();
    expect(await validatePublicWebhookTarget('http://localhost:8788/hook')).toContain('localhost');
  });

  it('rejects public IP literals because Workers fetch requires a hostname URL', async () => {
    expect(await validatePublicWebhookTarget('https://93.184.216.34/hook')).toContain('hostname');
    expect(await validatePublicWebhookTarget('https://[2606:2800:220:1:248:1893:25c8:1946]/hook')).toContain('hostname');
  });

  it('does not let ADMIN_OPEN_IN_DEV authorize loopback from a production origin', () => {
    expect(localWebhookTargetsAllowed(
      { ADMIN_OPEN_IN_DEV: 'true', APP_BASE_URL: 'https://congress.trade', USAGE_MONITOR_ENVIRONMENT: 'production' },
      'https://congress.trade/api/subscriptions',
    )).toBe(false);
    expect(localWebhookTargetsAllowed(
      { ADMIN_OPEN_IN_DEV: 'true', APP_BASE_URL: 'https://congress.trade' },
      'http://localhost:8787/api/subscriptions',
    )).toBe(true);
    expect(localWebhookTargetsAllowed({ USAGE_MONITOR_ENVIRONMENT: 'local' })).toBe(true);
  });
});
