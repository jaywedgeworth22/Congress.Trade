import { describe, expect, it } from 'vitest';
import {
  complianceInfo,
  formatAmount,
  formatEstimatedValue,
  formatShortDate,
  reportingLagDays,
} from '../formatters';

describe('trade formatters', () => {
  it('formats disclosed ranges and materialized estimates', () => {
    expect(formatAmount(15_001, 50_000)).toBe('$15,001 - $50,000');
    expect(formatAmount(1_000_001, null)).toBe('$1,000,001+');
    expect(formatAmount(null, 15_000)).toBe('Up to $15,000');
    expect(formatEstimatedValue(32_500.5)).toMatch(/^Est\. \$\d+K$/);
    expect(formatEstimatedValue(null)).toBe('Unknown');
  });

  it('formats dates in UTC and preserves invalid source values', () => {
    expect(formatShortDate('2026-05-05')).toBe('May 5, 2026');
    expect(formatShortDate('not-a-date')).toBe('not-a-date');
    expect(formatShortDate(null)).toBe('Unavailable');
  });

  it('computes reporting lag without local-time drift', () => {
    expect(reportingLagDays('2026-05-05', '2026-06-19')).toBe(45);
    expect(complianceInfo(45)).toEqual({ text: '45 days', className: 'compliance-yellow' });
    expect(complianceInfo(-2)).toEqual({ text: '2 days early', className: 'compliance-green' });
  });
});
