import { describe, expect, it } from 'vitest';
import { costProfilePublicSummary, resolveDenoCostProfile } from '../costProfile.ts';

describe('resolveDenoCostProfile', () => {
  it('defaults to free (Aug free-tier survival)', () => {
    const p = resolveDenoCostProfile({});
    expect(p.name).toBe('free');
    expect(p.cronSchedule).toBe('*/15 * * * *');
    expect(p.drainLimit).toBe(2);
    expect(p.drainClaimSize).toBe(1);
    expect(p.outboxLimit).toBe(10);
    expect(p.disableInternalCron).toBe(false);
    expect(p.idleShortCircuit).toBe(true);
  });

  it('prefers Deploy-safe CT_* names over legacy DENO_*', () => {
    const p = resolveDenoCostProfile({
      CT_COST_PROFILE: 'free',
      DENO_COST_PROFILE: 'paid',
    });
    expect(p.name).toBe('free');
  });

  it('maps pro/full aliases to paid', () => {
    expect(resolveDenoCostProfile({ CT_COST_PROFILE: 'pro' }).name).toBe('paid');
    expect(resolveDenoCostProfile({ CT_COST_PROFILE: 'full' }).cronSchedule).toBe('* * * * *');
  });

  it('honors balanced profile', () => {
    const p = resolveDenoCostProfile({ CT_COST_PROFILE: 'balanced' });
    expect(p.name).toBe('balanced');
    expect(p.cronSchedule).toBe('*/2 * * * *');
    expect(p.drainLimit).toBe(8);
  });

  it('allows per-knob overrides via CT_*', () => {
    const p = resolveDenoCostProfile({
      CT_COST_PROFILE: 'free',
      CT_CRON_SCHEDULE: '*/10 * * * *',
      CT_DRAIN_LIMIT: '7',
      CT_DRAIN_CLAIM_SIZE: '2',
      CT_OUTBOX_LIMIT: '15',
      CT_DISABLE_INTERNAL_CRON: 'true',
      CT_FORCE_FULL_TICK: '1',
    });
    expect(p.cronSchedule).toBe('*/10 * * * *');
    expect(p.drainLimit).toBe(7);
    expect(p.drainClaimSize).toBe(2);
    expect(p.outboxLimit).toBe(15);
    expect(p.disableInternalCron).toBe(true);
    expect(p.idleShortCircuit).toBe(false);
  });

  it('still accepts legacy DENO_* for local tests', () => {
    const p = resolveDenoCostProfile({ DENO_COST_PROFILE: 'paid' });
    expect(p.name).toBe('paid');
    expect(p.cronSchedule).toBe('* * * * *');
  });

  it('clamps absurd overrides', () => {
    const p = resolveDenoCostProfile({
      CT_DRAIN_LIMIT: '9999',
      CT_DRAIN_CLAIM_SIZE: '0',
      CT_OUTBOX_LIMIT: '-3',
    });
    expect(p.drainLimit).toBe(100);
    // invalid claim size falls back to free profile default (1)
    expect(p.drainClaimSize).toBe(1);
    // invalid outbox falls back to free profile default (10)
    expect(p.outboxLimit).toBe(10);
  });

  it('exposes a public summary without secrets', () => {
    const s = costProfilePublicSummary(resolveDenoCostProfile({ CT_COST_PROFILE: 'free' }));
    expect(s).toMatchObject({ name: 'free', cronSchedule: '*/15 * * * *', drainLimit: 2 });
  });
});
