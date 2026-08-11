import { describe, expect, it } from 'vitest';

import { formatMemberSeat } from '../routes.ts';
import { resolveOgMeta } from '../ogMeta.ts';

/**
 * `formatMemberSeat` is what makes the politician share card say
 * "Ro Khanna (D-CA-17)" instead of a bare name. Every shape asserted here was
 * taken from live `filers` rows, not invented — see the doc comment on the
 * function for the encodings that bite (NULL party, NULL district, '0' at-large).
 */
describe('formatMemberSeat', () => {
  it('formats a House seat as party-state-district', () => {
    expect(formatMemberSeat('house', 'Democrat', 'CA', '17')).toBe('D-CA-17');
    expect(formatMemberSeat('house', 'Republican', 'TX', '10')).toBe('R-TX-10');
  });

  it('formats a Senate seat with Sen instead of a district number', () => {
    // Senators carry a NULL district — the seat token must come from the chamber.
    expect(formatMemberSeat('senate', 'Republican', 'AL', null)).toBe('R-AL-Sen');
    expect(formatMemberSeat('senate', 'Democrat', 'DE', null)).toBe('D-DE-Sen');
  });

  it("renders at-large House seats as AL, never as district '0'", () => {
    // '0' is the at-large encoding. Printing "D-DE-0" would be plainly wrong.
    expect(formatMemberSeat('house', 'Democrat', 'DE', '0')).toBe('D-DE-AL');
    expect(formatMemberSeat('house', 'Republican', 'WY', '00')).toBe('R-WY-AL');
  });

  it('strips leading zeros from a padded district', () => {
    expect(formatMemberSeat('house', 'Democrat', 'NJ', '05')).toBe('D-NJ-5');
  });

  it('omits the party initial when party is unknown', () => {
    // ~14% of live filers have a NULL party; the seat is still worth showing.
    expect(formatMemberSeat('house', null, 'CA', '17')).toBe('CA-17');
    expect(formatMemberSeat('senate', '', 'TX', null)).toBe('TX-Sen');
  });

  it('returns null for executive-branch filers, who hold no seat', () => {
    // A lone "R" in parentheses would be noise, not information.
    expect(formatMemberSeat('executive', 'Republican', null, null)).toBeNull();
    expect(formatMemberSeat('executive', 'Republican', 'NY', null)).toBeNull();
  });

  it('returns null when the state is missing or blank', () => {
    expect(formatMemberSeat('house', 'Democrat', null, '17')).toBeNull();
    expect(formatMemberSeat('house', 'Democrat', '   ', '17')).toBeNull();
  });

  it('is case- and whitespace-insensitive on chamber and state', () => {
    expect(formatMemberSeat(' House ', 'Democrat', ' ca ', ' 17 ')).toBe('D-CA-17');
    expect(formatMemberSeat('SENATE', 'Independent', 'vt', null)).toBe('I-VT-Sen');
  });
});

describe('politician share title with a seat', () => {
  it('renders the seat in parentheses after the name', () => {
    const meta = resolveOgMeta('https://congress.trade/?member=K000389', 'https://congress.trade', {
      memberDisplayName: 'Ro Khanna',
      memberDistrict: formatMemberSeat('house', 'Democrat', 'CA', '17'),
    });
    expect(meta.title).toBe('Ro Khanna (D-CA-17)');
    // The redundant site suffix stays gone — the URL and card art already carry it.
    expect(meta.title).not.toContain('Congress.Trade');
  });

  it('falls back to a bare name when the filer has no seat', () => {
    const meta = resolveOgMeta('https://congress.trade/?member=T000000', 'https://congress.trade', {
      memberDisplayName: 'Donald J. Trump',
      memberDistrict: formatMemberSeat('executive', 'Republican', null, null),
    });
    expect(meta.title).toBe('Donald J. Trump');
  });
});
