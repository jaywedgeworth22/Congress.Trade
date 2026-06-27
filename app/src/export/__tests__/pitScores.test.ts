/**
 * src/export/__tests__/pitScores.test.ts
 *
 * Regression tests for the point-in-time score export helpers. The key safety
 * property: member skill must ignore any outcome whose evaluation horizon had
 * not matured by the observation's asOf date.
 */

import { describe, expect, it } from 'vitest';
import {
  MEMBER_SKILL_HORIZON_DAYS,
  computePitMemberSkillFromRows,
  parsePitScoreQuery,
  pitScoreRowsToNdjson,
  type PriceBar,
} from '../pitScores';

const prices = (rows: Array<[string, number]>): PriceBar[] =>
  rows.map(([date, close]) => ({ date, close }));

describe('computePitMemberSkillFromRows', () => {
  it('excludes member outcomes whose horizon had not matured before asOf', () => {
    const px = prices([
      ['2026-01-01', 100],
      ['2026-02-10', 110],
      ['2026-03-06', 120], // 63d after Jan 1 has matured by Mar 10.
    ]);
    const spx = prices([
      ['2026-01-01', 1000],
      ['2026-02-10', 1010],
      ['2026-03-06', 1020],
    ]);
    const skill = computePitMemberSkillFromRows(
      [
        { id: 'old', filerId: 'F1', ticker: 'AAPL', disclosureAvailableAt: '2026-01-01T00:00:00.000Z' },
        { id: 'immature', filerId: 'F1', ticker: 'AAPL', disclosureAvailableAt: '2026-02-10T00:00:00.000Z' },
      ],
      new Map([['AAPL', px]]),
      spx,
      '2026-03-10',
      42,
    );

    expect(MEMBER_SKILL_HORIZON_DAYS).toBe(63);
    expect(skill.scoredCount).toBe(1);
    expect(skill.sourceRecordIds).toEqual(['old']);
    expect(skill.skillScoredThrough).toBe('2026-03-06');
    expect(skill.fallback).toBeNull();
  });

  it('falls back to activity prominence when no matured labels exist', () => {
    const px = prices([
      ['2026-02-10', 110],
      ['2026-03-06', 120],
    ]);
    const spx = prices([
      ['2026-02-10', 1010],
      ['2026-03-06', 1020],
    ]);
    const skill = computePitMemberSkillFromRows(
      [{ id: 'immature', filerId: 'F1', ticker: 'AAPL', disclosureAvailableAt: '2026-02-10T00:00:00.000Z' }],
      new Map([['AAPL', px]]),
      spx,
      '2026-03-10',
      37,
    );

    expect(skill.scoredCount).toBe(0);
    expect(skill.skillScore).toBeNull();
    expect(skill.fallback).toBe('activity_prominence');
    expect(skill.fallbackScore).toBe(37);
    expect(skill.sourceRecordIds).toEqual([]);
  });
});

describe('parsePitScoreQuery', () => {
  it('validates date ranges and placebos', () => {
    expect(parsePitScoreQuery({ from: '2026-01-02', to: '2026-01-01' })).toMatchObject({ status: 400 });
    expect(parsePitScoreQuery({ placebo: 'bogus' })).toMatchObject({ status: 400 });
    expect(parsePitScoreQuery({ ticker: 'aapl', limit: '999', format: 'ndjson', placebo: 'no_flow' })).toMatchObject({
      ticker: 'AAPL',
      limit: 500,
      format: 'ndjson',
      placebo: 'no_flow',
    });
  });
});

describe('pitScoreRowsToNdjson', () => {
  it('emits one JSON line per row and an empty string for no rows', () => {
    expect(pitScoreRowsToNdjson([])).toBe('');
    expect(pitScoreRowsToNdjson([{ a: 1 }, { b: 2 }] as never)).toBe('{"a":1}\n{"b":2}\n');
  });
});
