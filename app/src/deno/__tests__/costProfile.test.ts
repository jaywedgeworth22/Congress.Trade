import { describe, expect, it } from 'vitest';
import { resolveDenoCostProfile } from '../costProfile.ts';

describe('resolveDenoCostProfile', () => {
  it('defaults to free (Aug free-tier survival)', () => {
    const p = resolveDenoCostProfile({});
    expect(p.name).toBe('free');
    expect(p.cronSchedule).toBe('*/5 * * * *');
    expect(p.drainLimit).toBe(3);
    expect(p.drainClaimSize).toBe(1);
    expect(p.outboxLimit).toBe(20);
    expect(p.disableInternalCron).toBe(false);
    expect(p.idleShortCircuit).toBe(true);
  });

  it('maps pro/full aliases to paid', () => {
    expect(resolveDenoCostProfile({ DENO_COST_PROFILE: 'pro' }).name).toBe('paid');
    expect(resolveDenoCostProfile({ DENO_COST_PROFILE: 'full' }).cronSchedule).toBe('* * * * *');
  });

  it('honors balanced profile', () => {
    const p = resolveDenoCostProfile({ DENO_COST_PROFILE: 'balanced' });
    expect(p.name).toBe('balanced');
    expect(p.cronSchedule).toBe('*/2 * * * *');
    expect(p.drainLimit).toBe(8);
  });

  it('allows per-knob overrides', () => {
    const p = resolveDenoCostProfile({
      DENO_COST_PROFILE: 'free',
      DENO_CRON_SCHEDULE: '*/10 * * * *',
      DENO_DRAIN_LIMIT: '7',
      DENO_DRAIN_CLAIM_SIZE: '2',
      DENO_OUTBOX_LIMIT: '15',
      DENO_DISABLE_INTERNAL_CRON: 'true',
      DENO_FORCE_FULL_TICK: '1',
    });
    expect(p.cronSchedule).toBe('*/10 * * * *');
    expect(p.drainLimit).toBe(7);
    expect(p.drainClaimSize).toBe(2);
    expect(p.outboxLimit).toBe(15);
    expect(p.disableInternalCron).toBe(true);
    expect(p.idleShortCircuit).toBe(false);
  });

  it('clamps absurd overrides', () => {
    const p = resolveDenoCostProfile({
      DENO_DRAIN_LIMIT: '9999',
      DENO_DRAIN_CLAIM_SIZE: '0',
      DENO_OUTBOX_LIMIT: '-3',
    });
    expect(p.drainLimit).toBe(100);
    // invalid claim size falls back to profile default
    expect(p.drainClaimSize).toBe(1);
    expect(p.outboxLimit).toBe(20);
  });
});
