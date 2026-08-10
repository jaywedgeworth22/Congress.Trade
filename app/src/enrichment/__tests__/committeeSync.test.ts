/**
 * src/enrichment/__tests__/committeeSync.test.ts
 *
 * Unit tests for the committee-membership sync: committees-current +
 * committee-membership-current parsing, subcommittee rollup/dedupe, that the
 * resulting display names actually hit conflicts.ts's curated
 * committee->sector matcher, and the update-plan logic (skip unchanged /
 * unmatched, only touch resolved_bioguide_id filers).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  buildCommitteeIndex,
  buildBioguideCommitteeMap,
  planCommitteeUpdates,
  fetchBioguideCommitteeMap,
  runCommitteeSync,
  COMMITTEES_CURRENT_URL,
  COMMITTEE_MEMBERSHIP_URL,
  type CommitteeRecord,
  type CommitteeMembershipMap,
  type FilerCommitteeRow,
} from '../committeeSync.ts';
import { committeeConflict, oversightSectors } from '../../analytics/conflicts.ts';
import { openMigratedD1 } from '../../prices/__tests__/sqliteD1.ts';
import type { Env } from '../../shared/types.ts';

// A trimmed-but-real-shaped fixture: a few top-level committees (one with a
// subcommittee), mirroring committees-current.json's actual field names.
const FIXTURE_COMMITTEES: CommitteeRecord[] = [
  {
    type: 'house',
    name: 'House Committee on Agriculture',
    thomas_id: 'HSAG',
    subcommittees: [{ thomas_id: '15', name: 'Forestry and Horticulture' }],
  },
  {
    type: 'house',
    name: 'House Committee on Financial Services',
    thomas_id: 'HSBA',
    subcommittees: [{ thomas_id: '20', name: 'Capital Markets' }],
  },
  {
    type: 'senate',
    name: 'Senate Committee on Armed Services',
    thomas_id: 'SSAS',
  },
  {
    type: 'senate',
    name: 'Senate Committee on Finance',
    thomas_id: 'SSFI',
  },
  // Missing thomas_id/name — must be skipped, not crash.
  { type: 'joint', name: undefined, thomas_id: 'JUNK' } as unknown as CommitteeRecord,
];

// Membership keyed the way committee-membership-current.json actually is:
// top-level thomas_id for full-committee members, thomas_id+subcommittee
// thomas_id for subcommittee-only members.
const FIXTURE_MEMBERSHIP: CommitteeMembershipMap = {
  HSAG: [
    { name: 'Jane Farmer', bioguide: 'F000111', party: 'majority', rank: 1, title: 'Chair' },
    { name: 'Sam Rancher', bioguide: 'R000222' },
  ],
  HSAG15: [
    // Subcommittee-only membership for someone NOT on the full committee list
    // above — still must roll up to "House Committee on Agriculture".
    { name: 'Pat Forester', bioguide: 'F000333' },
    // Also appears on the full committee (HSAG) — must dedupe to one name.
    { name: 'Jane Farmer', bioguide: 'F000111' },
  ],
  HSBA: [{ name: 'Alex Banker', bioguide: 'B000444' }],
  HSBA20: [{ name: 'Alex Banker', bioguide: 'B000444' }],
  SSAS: [{ name: 'Chris Colonel', bioguide: 'C000555' }],
  SSFI: [{ name: 'Alex Banker', bioguide: 'B000444' }], // sits on two committees
  // A key with no corresponding committee record (stale/unmapped) — skipped.
  ZZZZ: [{ name: 'Nobody', bioguide: 'N000999' }],
  // A member entry missing bioguide — skipped, not crash.
  HSFAKE: [{ name: 'No Bioguide' }] as never,
};

function fixtureMap(): Map<string, string[]> {
  const index = buildCommitteeIndex(FIXTURE_COMMITTEES);
  return buildBioguideCommitteeMap(FIXTURE_MEMBERSHIP, index);
}

describe('buildCommitteeIndex', () => {
  it('indexes top-level committees and rolls subcommittee keys up to their parent thomas_id', () => {
    const index = buildCommitteeIndex(FIXTURE_COMMITTEES);
    expect(index.nameByThomasId.get('HSAG')).toBe('House Committee on Agriculture');
    expect(index.parentThomasIdByKey.get('HSAG')).toBe('HSAG');
    expect(index.parentThomasIdByKey.get('HSAG15')).toBe('HSAG');
    expect(index.parentThomasIdByKey.get('HSBA20')).toBe('HSBA');
    expect(index.parentThomasIdByKey.has('JUNK')).toBe(false); // no name -> skipped
  });
});

describe('buildBioguideCommitteeMap', () => {
  it('rolls subcommittee memberships up to the parent committee display name', () => {
    const map = fixtureMap();
    // Subcommittee-only member still gets the parent committee name.
    expect(map.get('F000333')).toEqual(['House Committee on Agriculture']);
  });

  it('dedupes when a member appears on both the full committee and its subcommittee', () => {
    const map = fixtureMap();
    expect(map.get('F000111')).toEqual(['House Committee on Agriculture']);
    expect(map.get('B000444')).toEqual(
      ['House Committee on Financial Services', 'Senate Committee on Finance'].slice().sort(),
    );
  });

  it('sorts the output names deterministically', () => {
    const map = fixtureMap();
    const names = map.get('B000444')!;
    expect(names).toEqual([...names].sort());
  });

  it('skips membership keys with no matching committee record', () => {
    const map = fixtureMap();
    expect(map.has('N000999')).toBe(false);
  });

  it('skips member entries with no bioguide id', () => {
    const map = fixtureMap();
    for (const names of map.values()) {
      expect(names).not.toContain('No Bioguide');
    }
  });
});

describe('committee names match conflicts.ts COMMITTEE_SECTOR_RULES', () => {
  it('a real Financial Services member is flagged for a Financials-sector trade', () => {
    const map = fixtureMap();
    const committees = map.get('B000444')!; // Financial Services + Finance
    const result = committeeConflict(committees, 'Financials');
    expect(result.conflict).toBe(true);
    expect(result.viaCommittees.length).toBeGreaterThan(0);
  });

  it('a real Armed Services member is flagged for an Industrials-sector trade', () => {
    const map = fixtureMap();
    const committees = map.get('C000555')!;
    expect(oversightSectors(committees).has('Industrials')).toBe(true);
    expect(committeeConflict(committees, 'Industrials').conflict).toBe(true);
  });

  it('does not false-positive Senate Finance against "Financials" leaking into unrelated sectors', () => {
    // Senate Finance oversees Health Care + Financials per the curated map —
    // a Materials-sector trade should NOT be flagged via Finance alone.
    const map = fixtureMap();
    const financeOnly = ['Senate Committee on Finance'];
    expect(committeeConflict(financeOnly, 'Materials').conflict).toBe(false);
    expect(committeeConflict(financeOnly, 'Financials').conflict).toBe(true);
  });

  it('an Agriculture committee member (full + subcommittee rollup) matches the agriculture rule', () => {
    const map = fixtureMap();
    const committees = map.get('F000111')!;
    expect(committeeConflict(committees, 'Consumer Staples').conflict).toBe(true);
  });
});

describe('planCommitteeUpdates', () => {
  const bioguideMap = new Map<string, string[]>([
    ['B000444', ['House Committee on Financial Services', 'Senate Committee on Finance']],
    ['C000555', ['Senate Committee on Armed Services']],
  ]);

  it('produces an update for a resolved filer whose stored committees differ', () => {
    const filers: FilerCommitteeRow[] = [
      { bioguide_id: 'house-x1-alex-banker', resolved_bioguide_id: 'B000444', committees: '[]' },
    ];
    const plan = planCommitteeUpdates(filers, bioguideMap);
    expect(plan.updates).toEqual([
      {
        filerId: 'house-x1-alex-banker',
        committees: ['House Committee on Financial Services', 'Senate Committee on Finance'],
      },
    ]);
    expect(plan.skipped).toBe(0);
    expect(plan.unmatched).toBe(0);
  });

  it('skips a filer whose stored committees JSON already matches (idempotent re-run)', () => {
    const filers: FilerCommitteeRow[] = [
      {
        bioguide_id: 'senate-armed-chris',
        resolved_bioguide_id: 'C000555',
        committees: JSON.stringify(['Senate Committee on Armed Services']),
      },
    ];
    const plan = planCommitteeUpdates(filers, bioguideMap);
    expect(plan.updates).toEqual([]);
    expect(plan.skipped).toBe(1);
    expect(plan.unmatched).toBe(0);
  });

  it('counts a resolved filer with no memberships as unmatched, not updated', () => {
    const filers: FilerCommitteeRow[] = [
      { bioguide_id: 'house-nobody', resolved_bioguide_id: 'N000000', committees: null },
    ];
    const plan = planCommitteeUpdates(filers, bioguideMap);
    expect(plan.updates).toEqual([]);
    expect(plan.skipped).toBe(0);
    expect(plan.unmatched).toBe(1);
  });

  it('ignores filers with no resolved_bioguide_id entirely (out of scope for this sync)', () => {
    const filers: FilerCommitteeRow[] = [
      { bioguide_id: 'house-unresolved', resolved_bioguide_id: null, committees: null },
    ];
    const plan = planCommitteeUpdates(filers, bioguideMap);
    expect(plan.updates).toEqual([]);
    expect(plan.skipped).toBe(0);
    expect(plan.unmatched).toBe(0);
  });
});

describe('fetchBioguideCommitteeMap', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches both hosted URLs and builds the rolled-up map', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === COMMITTEES_CURRENT_URL) {
        return new Response(JSON.stringify(FIXTURE_COMMITTEES), { status: 200 });
      }
      if (url === COMMITTEE_MEMBERSHIP_URL) {
        return new Response(JSON.stringify(FIXTURE_MEMBERSHIP), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchImpl);

    const map = await fetchBioguideCommitteeMap();
    expect(map.get('C000555')).toEqual(['Senate Committee on Armed Services']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws when a source URL responds non-OK', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    vi.stubGlobal('fetch', fetchImpl);
    await expect(fetchBioguideCommitteeMap()).rejects.toThrow(/fetch failed/i);
  });
});

describe('runCommitteeSync (integration, in-memory D1)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes committees for resolved filers, skips unresolved/unmatched, and is idempotent', async () => {
    const { d1, close } = await openMigratedD1();
    try {
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === COMMITTEES_CURRENT_URL) {
          return new Response(JSON.stringify(FIXTURE_COMMITTEES), { status: 200 });
        }
        if (url === COMMITTEE_MEMBERSHIP_URL) {
          return new Response(JSON.stringify(FIXTURE_MEMBERSHIP), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      });
      vi.stubGlobal('fetch', fetchImpl);

      await d1
        .prepare(
          "INSERT INTO filers (bioguide_id, chamber, full_name, party, state, district, committees, resolved_bioguide_id) " +
            "VALUES ('senate-armed-chris', 'senate', 'Chris Colonel', 'R', 'TX', '', '[]', 'C000555')",
        )
        .run();
      await d1
        .prepare(
          "INSERT INTO filers (bioguide_id, chamber, full_name, party, state, district, committees, resolved_bioguide_id) " +
            "VALUES ('house-unresolved', 'house', 'No Bioguide Yet', 'D', 'CA', '12', NULL, NULL)",
        )
        .run();
      await d1
        .prepare(
          "INSERT INTO filers (bioguide_id, chamber, full_name, party, state, district, committees, resolved_bioguide_id) " +
            "VALUES ('house-no-committees', 'house', 'Nobody Serves', 'I', 'NY', '3', NULL, 'N000000')",
        )
        .run();

      const env = { DB: d1 } as unknown as Env;
      const result = await runCommitteeSync(env);
      expect(result.filersScanned).toBe(2); // resolved_bioguide_id IS NOT NULL rows only
      expect(result.updated).toBe(1); // senate-armed-chris
      expect(result.unmatched).toBe(1); // house-no-committees (N000000 has no memberships)
      expect(result.skipped).toBe(0);

      const row = await d1.prepare('SELECT committees FROM filers WHERE bioguide_id = ?').bind('senate-armed-chris').first<{
        committees: string;
      }>();
      expect(JSON.parse(row!.committees)).toEqual(['Senate Committee on Armed Services']);

      const untouched = await d1
        .prepare('SELECT committees FROM filers WHERE bioguide_id = ?')
        .bind('house-unresolved')
        .first<{ committees: string | null }>();
      expect(untouched!.committees).toBeNull();

      // Re-run: same fetch fixtures, nothing should change (idempotent).
      const second = await runCommitteeSync(env);
      expect(second.updated).toBe(0);
      expect(second.skipped).toBe(1);
      expect(second.unmatched).toBe(1);
    } finally {
      close();
    }
  });
});
