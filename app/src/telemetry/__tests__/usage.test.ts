import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../shared/types';
import { sendUsageTelemetry } from '../usage';

function env(extra: Partial<Env> = {}): Env {
  return extra as Env;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('usage telemetry', () => {
  it('requires explicit USAGE_MONITOR_ENABLED opt-in before sending', async () => {
    const fetchMock = vi.fn(async () => Response.json({ accepted: 1 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await sendUsageTelemetry(
      env({
        USAGE_MONITOR_INGEST_URL: 'https://usage.example.test/ingest',
        USAGE_MONITOR_INGEST_TOKEN: 'token',
      }),
      [{ provider: 'fmp', quantity: 1, unit: 'call' }],
    );

    expect(res).toEqual({ sent: false, reason: 'disabled' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends when explicitly enabled and configured', async () => {
    const fetchMock = vi.fn(async () => Response.json({ accepted: 1 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await sendUsageTelemetry(
      env({
        USAGE_MONITOR_ENABLED: 'true',
        USAGE_MONITOR_INGEST_URL: 'https://usage.example.test/ingest',
        USAGE_MONITOR_INGEST_TOKEN: 'token',
      }),
      [{ provider: 'fmp', quantity: 1, unit: 'call' }],
    );

    expect(res).toEqual({ sent: true, accepted: 1 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
