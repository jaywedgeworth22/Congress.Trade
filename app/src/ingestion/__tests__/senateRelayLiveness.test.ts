import { describe, expect, it } from 'vitest';
import {
  isLivenessProbe,
  livenessPayload,
  livenessResponse,
} from '../../../../scout/liveness.ts';

describe('senate-relay liveness (scout / mac parity)', () => {
  it('treats GET and HEAD on / and /health as liveness', () => {
    expect(isLivenessProbe('GET', '/')).toBe(true);
    expect(isLivenessProbe('HEAD', '/')).toBe(true);
    expect(isLivenessProbe('GET', '/health')).toBe(true);
    expect(isLivenessProbe('HEAD', '/health')).toBe(true);
  });

  it('does not steal fetch-doc or fetch-ptr', () => {
    expect(isLivenessProbe('POST', '/fetch-doc')).toBe(false);
    expect(isLivenessProbe('POST', '/fetch-ptr')).toBe(false);
    expect(isLivenessProbe('GET', '/fetch-doc')).toBe(false);
    expect(isLivenessProbe('OPTIONS', '/health')).toBe(false);
  });

  it('returns the same JSON body on GET / and GET /health', async () => {
    const payload = livenessPayload(12);
    expect(payload).toEqual({ ok: true, service: 'senate-relay', uptimeSeconds: 12 });

    const root = livenessResponse('GET', 12);
    const health = livenessResponse('GET', 12);
    expect(root.status).toBe(200);
    expect(health.status).toBe(200);
    expect(root.headers.get('content-type')).toBe('application/json');
    expect(await root.json()).toEqual(payload);
    expect(await health.json()).toEqual(payload);
  });

  it('returns 200 with an empty body on HEAD', async () => {
    const res = livenessResponse('HEAD', 12);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.text()).toBe('');
  });
});
