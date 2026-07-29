import { describe, expect, it } from 'vitest';
import {
  asStockActStatus,
  computeDisclosureLagDays,
  computeStockActStatus,
  STOCK_ACT_DEADLINE_DAYS,
  stockActStatusForLag,
} from '../stockAct.ts';

describe('computeDisclosureLagDays', () => {
  it('returns whole days between trade and filing dates', () => {
    expect(computeDisclosureLagDays('2024-01-01', '2024-02-15')).toBe(45);
    expect(computeDisclosureLagDays('2024-01-01', '2024-01-01')).toBe(0);
    expect(computeDisclosureLagDays('2024-03-10', '2024-08-01')).toBe(144);
  });

  it('truncates toward zero like SQLite CAST(... AS INTEGER)', () => {
    // 1.5 days -> 1; -1.5 days -> -1 (not -2).
    expect(computeDisclosureLagDays('2024-01-01', '2024-01-02T12:00:00Z')).toBe(1);
    expect(computeDisclosureLagDays('2024-01-02T12:00:00Z', '2024-01-01')).toBe(-1);
  });

  it('keeps negative lags (filing dated before trade — amendments/noise)', () => {
    expect(computeDisclosureLagDays('2024-05-10', '2024-05-01')).toBe(-9);
  });

  it('returns null when either date is missing or unparseable', () => {
    expect(computeDisclosureLagDays(null, '2024-01-01')).toBeNull();
    expect(computeDisclosureLagDays('2024-01-01', null)).toBeNull();
    expect(computeDisclosureLagDays('2024-01-01', undefined)).toBeNull();
    expect(computeDisclosureLagDays('not-a-date', '2024-01-01')).toBeNull();
    expect(computeDisclosureLagDays('2024-01-01', '')).toBeNull();
  });
});

describe('stockActStatusForLag', () => {
  it('classifies the 45-day deadline inclusively', () => {
    expect(stockActStatusForLag(0)).toBe('on_time');
    expect(stockActStatusForLag(STOCK_ACT_DEADLINE_DAYS)).toBe('on_time');
    expect(stockActStatusForLag(STOCK_ACT_DEADLINE_DAYS + 1)).toBe('late');
  });

  it('classifies severely late beyond 120 days', () => {
    expect(stockActStatusForLag(120)).toBe('late');
    expect(stockActStatusForLag(121)).toBe('severely_late');
  });

  it('treats negative lags as on_time and null/NaN as unknown', () => {
    expect(stockActStatusForLag(-30)).toBe('on_time');
    expect(stockActStatusForLag(null)).toBeNull();
    expect(stockActStatusForLag(undefined)).toBeNull();
    expect(stockActStatusForLag(NaN)).toBeNull();
  });
});

describe('computeStockActStatus', () => {
  it('composes lag + classification', () => {
    expect(computeStockActStatus('2024-01-01', '2024-02-15')).toBe('on_time');
    expect(computeStockActStatus('2024-01-01', '2024-03-01')).toBe('late');
    expect(computeStockActStatus('2024-01-01', '2024-08-01')).toBe('severely_late');
    expect(computeStockActStatus('2024-01-01', null)).toBeNull();
  });
});

describe('asStockActStatus', () => {
  it('accepts only the closed enum', () => {
    expect(asStockActStatus('late')).toBe('late');
    expect(asStockActStatus('on_time')).toBe('on_time');
    expect(asStockActStatus('severely_late')).toBe('severely_late');
    expect(asStockActStatus('LATE')).toBeUndefined();
    expect(asStockActStatus('')).toBeUndefined();
    expect(asStockActStatus(undefined)).toBeUndefined();
    expect(asStockActStatus('bogus')).toBeUndefined();
  });
});
