import { describe, it, expect } from 'vitest';
import { backfillHouseIndex } from '../watcher';
import type { HouseFiling } from '../houseSource';
import type { Env } from '../../shared/types';

function filing(over: Partial<HouseFiling> = {}): HouseFiling {
  return {
    docId: '20012345',
    filingType: 'P',
    year: '2024',
    first: 'Jane',
    last: 'Smith',
    stateDst: 'CA01',
    isPtr: true,
    pipelineDocId: 'H-2024-20012345',
    sourceUrl: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2024/20012345.pdf',
    ...over,
  };
}

describe('backfillHouseIndex (dryRun)', () => {
  // dryRun never touches DB/queue, so a bare cast env is sufficient.
  const env = {} as Env;

  it('counts PTRs per year and ignores non-PTR rows', async () => {
    const calls: Array<number | string> = [];
    const fetchIndex = async (year: number | string) => {
      calls.push(year);
      return [
        filing({ pipelineDocId: `H-${year}-1`, docId: '1' }),
        filing({ pipelineDocId: `H-${year}-2`, docId: '2' }),
        filing({ pipelineDocId: `H-${year}-3`, docId: '3', isPtr: false, filingType: 'O' }),
      ];
    };

    const res = await backfillHouseIndex(env, { years: [2023, 2024], dryRun: true }, fetchIndex);

    expect(calls).toEqual([2023, 2024]);
    expect(res.byYear[2023]).toEqual({ found: 2, enqueued: 0 });
    expect(res.byYear[2024]).toEqual({ found: 2, enqueued: 0 });
    expect(res.totalEnqueued).toBe(0);
    expect(res.errors).toEqual([]);
  });

  it('fails soft per year, continuing past a failing year', async () => {
    const fetchIndex = async (year: number | string) => {
      if (year === 2023) throw new Error('zip 404');
      return [filing({ pipelineDocId: `H-${year}-1`, docId: '1' })];
    };

    const res = await backfillHouseIndex(env, { years: [2023, 2024], dryRun: true }, fetchIndex);

    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toContain('2023');
    expect(res.byYear[2024]).toEqual({ found: 1, enqueued: 0 });
  });
});
