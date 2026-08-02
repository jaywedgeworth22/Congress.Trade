import { describe, expect, it } from 'vitest';
import {
  evaluatePipelineSignals,
  type PipelineSignals,
  DEFAULT_PIPELINE_THRESHOLDS,
} from '../pipelineHealth.ts';

describe('evaluatePipelineSignals', () => {
  const nowMs = 1754092800000; // Fixed clock for testing

  const cleanSignals: PipelineSignals = {
    outboxPending: 0,
    outboxOldestAt: null,
    outboxFailed: 0,
    reviewBacklog: 5,
    extractionAttempts24h: 10,
    extractionOk24h: 10,
    lastExtractionSuccessAt: new Date(nowMs - 3600 * 1000).toISOString(),
    autopilotHaltReason: null,
    latestTxCreatedAt: new Date(nowMs - 3600 * 1000).toISOString(),
  };

  it('returns ok status for clean pipeline signals', () => {
    const res = evaluatePipelineSignals(cleanSignals, nowMs);
    expect(res.status).toBe('ok');
    expect(res.checks.every((c) => c.status === 'ok')).toBe(true);
  });

  it('returns unknown status when signals are null', () => {
    const nullSignals: PipelineSignals = {
      outboxPending: null,
      outboxOldestAt: null,
      outboxFailed: null,
      reviewBacklog: null,
      extractionAttempts24h: null,
      extractionOk24h: null,
      lastExtractionSuccessAt: null,
      autopilotHaltReason: null,
      latestTxCreatedAt: null,
    };
    const res = evaluatePipelineSignals(nullSignals, nowMs);
    expect(res.status).toBe('unknown');
    expect(res.checks.every((c) => c.status === 'unknown' || c.status === 'ok')).toBe(true);
  });

  it('flags stalled when 0/N extractions succeed in 24h (403/budget stall case)', () => {
    const stalledSignals: PipelineSignals = {
      ...cleanSignals,
      extractionAttempts24h: 40,
      extractionOk24h: 0,
    };
    const res = evaluatePipelineSignals(stalledSignals, nowMs);
    expect(res.status).toBe('stalled');
    const providerCheck = res.checks.find((c) => c.id === 'extraction_provider');
    expect(providerCheck?.status).toBe('stalled');
  });

  it('flags stalled when autopilot is halted', () => {
    const haltedSignals: PipelineSignals = {
      ...cleanSignals,
      autopilotHaltReason: 'error_class:billing',
    };
    const res = evaluatePipelineSignals(haltedSignals, nowMs);
    expect(res.status).toBe('stalled');
    const haltCheck = res.checks.find((c) => c.id === 'autopilot_halt');
    expect(haltCheck?.status).toBe('stalled');
    expect(haltCheck?.detail).toContain('error_class:billing');
  });

  it('flags stalled when review backlog is elevated with zero 24h extraction attempts', () => {
    const backlogStallSignals: PipelineSignals = {
      ...cleanSignals,
      reviewBacklog: 200,
      extractionAttempts24h: 0,
      extractionOk24h: 0,
    };
    const res = evaluatePipelineSignals(backlogStallSignals, nowMs);
    expect(res.status).toBe('stalled');
    const backlogCheck = res.checks.find((c) => c.id === 'extraction_backlog');
    expect(backlogCheck?.status).toBe('stalled');
  });

  it('flags stalled when outbox pending items exceed max age threshold', () => {
    const oldestMs = nowMs - (120 * 60 * 1000); // 120m old, > 90m limit
    const outboxStallSignals: PipelineSignals = {
      ...cleanSignals,
      outboxPending: 5,
      outboxOldestAt: new Date(oldestMs).toISOString(),
    };
    const res = evaluatePipelineSignals(outboxStallSignals, nowMs);
    expect(res.status).toBe('stalled');
    const outboxCheck = res.checks.find((c) => c.id === 'ingestion_backlog');
    expect(outboxCheck?.status).toBe('stalled');
  });

  it('flags degraded (never stalled) when transaction data is stale (recess guard)', () => {
    const staleTxMs = nowMs - (120 * 3600 * 1000); // 120h old, > 96h limit
    const staleTxSignals: PipelineSignals = {
      ...cleanSignals,
      latestTxCreatedAt: new Date(staleTxMs).toISOString(),
    };
    const res = evaluatePipelineSignals(staleTxSignals, nowMs);
    expect(res.status).toBe('degraded');
    const txCheck = res.checks.find((c) => c.id === 'data_freshness');
    expect(txCheck?.status).toBe('degraded');
  });
});
