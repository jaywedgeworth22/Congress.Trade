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
    dishonestResolutionCount: 0,
    orphanedNeedsReviewCount: 0,
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
      dishonestResolutionCount: null,
      orphanedNeedsReviewCount: null,
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

  // --- review_resolution_integrity (2026-08-09 production bug) -------------
  // review_queue reported resolved=1 for 3,497/3,497 rows (hence the review
  // UI saying "all done" daily) while 738 of those had zero live
  // transactions and 180 needs_review filings had no open queue row. This
  // check is the seeded-738-style regression guard the incident asked for.
  describe('review_resolution_integrity', () => {
    it('flags degraded when resolved rows carry no recorded resolution reason (the 738 case)', () => {
      const dishonestSignals: PipelineSignals = {
        ...cleanSignals,
        dishonestResolutionCount: 738,
      };
      const res = evaluatePipelineSignals(dishonestSignals, nowMs);
      expect(res.status).toBe('degraded');
      const check = res.checks.find((c) => c.id === 'review_resolution_integrity');
      expect(check?.status).toBe('degraded');
      expect(check?.detail).toContain('738');
      expect(check?.value).toBe(738);
    });

    it('flags degraded when needs_review filings have no open queue row (the 180 case)', () => {
      const orphanedSignals: PipelineSignals = {
        ...cleanSignals,
        orphanedNeedsReviewCount: 180,
      };
      const res = evaluatePipelineSignals(orphanedSignals, nowMs);
      expect(res.status).toBe('degraded');
      const check = res.checks.find((c) => c.id === 'review_resolution_integrity');
      expect(check?.status).toBe('degraded');
      expect(check?.detail).toContain('180');
    });

    it('stays ok when every resolved row has a recorded reason and every needs_review filing has an open queue row', () => {
      const res = evaluatePipelineSignals(cleanSignals, nowMs);
      const check = res.checks.find((c) => c.id === 'review_resolution_integrity');
      expect(check?.status).toBe('ok');
      expect(check?.value).toBe(0);
    });

    it('reports unknown (not ok) when integrity counts could not be collected', () => {
      const uncollectedSignals: PipelineSignals = {
        ...cleanSignals,
        dishonestResolutionCount: null,
        orphanedNeedsReviewCount: null,
      };
      const res = evaluatePipelineSignals(uncollectedSignals, nowMs);
      const check = res.checks.find((c) => c.id === 'review_resolution_integrity');
      expect(check?.status).toBe('unknown');
    });
  });
});
