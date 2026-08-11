import { describe, expect, it } from 'vitest';
import {
  cleanAssetString,
  cleanFilerName,
  isJunkAssetString,
  splitAssetNameDetail,
} from '../nameNormalizer.ts';

describe('cleanFilerName', () => {
  it('removes embedded honorifics without joining adjacent words', () => {
    expect(cleanFilerName('Richard Dean Dr McCormick')).toBe('Richard Dean McCormick');
  });

  it('removes academic and medical titles with source punctuation', () => {
    expect(cleanFilerName('Neal Patrick MD, Facs Dunn')).toBe('Neal Patrick Dunn');
  });

  it('does not remove title-like substrings from ordinary names', () => {
    expect(cleanFilerName('Drake')).toBe('Drake');
    expect(cleanFilerName('Senatorial')).toBe('Senatorial');
  });

  it('maps curated legal names onto preferred public names', () => {
    expect(cleanFilerName('Rohit Khanna')).toBe('Ro Khanna');
    expect(cleanFilerName('Khanna, Rohit')).toBe('Ro Khanna');
  });
});

describe('isJunkAssetString & cleanAssetString', () => {
  it('identifies dot leaders and OCR junk strings as junk asset strings', () => {
    expect(isJunkAssetString('........................................')).toBe(true);
    expect(isJunkAssetString('......s')).toBe(true);
    expect(isJunkAssetString('..........A')).toBe(true);
    expect(isJunkAssetString('........')).toBe(true);
    expect(isJunkAssetString('..o')).toBe(true);
    expect(isJunkAssetString('...................0')).toBe(true);
    expect(isJunkAssetString('Unparsed Historical Filing')).toBe(true);
  });

  it('preserves valid asset names and tickers', () => {
    expect(isJunkAssetString('Apple Inc.')).toBe(false);
    expect(isJunkAssetString('AT&T')).toBe(false);
    expect(isJunkAssetString('3M')).toBe(false);
    expect(cleanAssetString('Apple Inc.')).toBe('Apple Inc.');
    expect(cleanAssetString('........................................')).toBe('');
    expect(cleanAssetString('......s')).toBe('');
    expect(cleanAssetString('ARCC ..', 'ARCC')).toBe('ARCC');
    expect(cleanAssetString('ARCC ................................', 'ARCC')).toBe('ARCC');
    expect(cleanAssetString('.....]')).toBe('');
    expect(cleanAssetString('XOM ....k', 'XOM')).toBe('XOM');
    expect(cleanAssetString('...................e')).toBe('');
  });
});

describe('splitAssetNameDetail', () => {
  /**
   * THE REGRESSION THAT COST 790 FALSE POSITIVES.
   *
   * An earlier dry run trimmed trailing ' .,-' off every asset name and
   * silently rewrote 790 ordinary company names ("Adobe Inc." -> "Adobe Inc",
   * "AT&T Inc." -> "AT&T Inc"). This split touches WHITESPACE ONLY. If this
   * test ever goes red, the character class widened — revert, do not "fix".
   */
  it('returns ordinary company names byte-for-byte unchanged, with no note', () => {
    for (const name of [
      'Adobe Inc.',
      'AT&T Inc.',
      'Apple Inc.',
      'Alphabet Inc. Class A',
      'Berkshire Hathaway Inc.',
      'Johnson & Johnson',
      'Amazon.com, Inc.',
      'The Home Depot, Inc.',
      '3M Company',
      'E.I. du Pont de Nemours and Co.',
    ]) {
      const out = splitAssetNameDetail(name);
      expect(out.name).toBe(name);
      expect(out.note).toBeNull();
    }
  });

  it('strips trailing House asset-type codes without eating the bracket', () => {
    // cleanAssetString alone truncates the closing ']' via its OCR rule and
    // leaves "US Treasury Bill [GS" — the split has to run first.
    expect(cleanAssetString('US Treasury Bill [GS]')).toBe('US Treasury Bill [GS');
    expect(splitAssetNameDetail('US Treasury Bill [GS]')).toEqual({ name: 'US Treasury Bill', note: null });
    expect(splitAssetNameDetail('Apollo Debt Solutions BDC Class S [OT]').name).toBe(
      'Apollo Debt Solutions BDC Class S',
    );
    expect(splitAssetNameDetail('Myno Carbon Corp convertible note [CS]').name).toBe(
      'Myno Carbon Corp. convertible note',
    );
  });

  it('strips numeric footnote markers, including repeats', () => {
    expect(splitAssetNameDetail('US TREASURY BILLS DUE 04/01/2021 [1]').name).toBe('Us Treasury Bills');
    expect(splitAssetNameDetail('US TREASURY BILLS DUE 04/01/2021 [1][2]').name).toBe('Us Treasury Bills');
  });

  it('keeps bracketed content that is real disclosed detail', () => {
    // "[15294% Interest]" is neither a House code nor a footnote marker.
    expect(splitAssetNameDetail('Lisa Family Investments LP [15294% Interest]').name).toContain(
      '[15294% Interest',
    );
  });

  it('moves the rigid Rate/Coupon + Matures suffix into the note', () => {
    expect(
      splitAssetNameDetail('Port of Seattle Washington Revenue Bond Rate/Coupon: 5.0% Matures: 05/01/2026'),
    ).toEqual({
      name: 'Port of Seattle Washington Revenue Bond',
      note: 'coupon 5.0%, matures 05/01/2026',
    });
    // Bare integer coupon ("5", no percent sign) still reads as a rate.
    expect(
      splitAssetNameDetail('New York Ny General Obligation Municipal Bond Rate/Coupon: 5 Matures: 12/01/2041'),
    ).toEqual({
      name: 'New York Ny General Obligation Municipal Bond',
      note: 'coupon 5%, matures 12/01/2041',
    });
  });

  it('moves the "Due <date>" maturity suffix in each order it is disclosed', () => {
    expect(splitAssetNameDetail('Illinois ST Sales Tax Rev JR Oblig 4.00% Due Jun 15, 2030')).toEqual({
      name: 'Illinois ST Sales Tax Rev JR Oblig',
      note: 'coupon 4.00%, matures Jun 15, 2030',
    });
    expect(splitAssetNameDetail('Maryland ST Go BDS Ser. 2017 B 5.00 % Due Aug 1, 2026').note).toBe(
      'coupon 5.00%, matures Aug 1, 2026',
    );
    expect(splitAssetNameDetail('US TREASURY DUE 08/15/2030 0.625%')).toEqual({
      name: 'Us Treasury',
      note: 'coupon 0.625%, matures 08/15/2030',
    });
    expect(
      splitAssetNameDetail('The Southern Company Series 2025a 6.50% Junior Subordinated Notes Due March 15, 2085'),
    ).toEqual({
      name: 'The Southern Company Series 2025a 6.50% Junior Subordinated Notes',
      note: 'matures March 15, 2085',
    });
  });

  /**
   * KNOWN LIMIT, deliberate. Once the rigid suffix is gone an inline
   * "4.00% 12/1/32" can remain — that is genuinely part of the muni's name, and
   * no rule can tell it from a name that simply contains a number. Leave it.
   */
  it('leaves inline rate/date residue inside the name alone', () => {
    expect(splitAssetNameDetail('King Cnty Wash Ltd. 4.00% 12/1/32 [GS]').name).toBe(
      'King Cnty Wash Ltd. 4.00% 12/1/32',
    );
    expect(splitAssetNameDetail('Madison Conn Go BD 3.5% 12/18/25 [GS]').name).toBe(
      'Madison Conn Go BD 3.5% 12/18/25',
    );
    expect(splitAssetNameDetail('Virginia ST 4.00% 8/1/38 [GS]').name).toBe('Virginia ST 4.00% 8/1/38');
    expect(splitAssetNameDetail('Chicago IL MTN WTR Reclamation Dist 10/01/2035 3.000% [1]').name).toContain(
      '10/01/2035 3.000%',
    );
  });

  it('keeps only the disclosed leg of an exchange and notes the counterparty', () => {
    // The PTR row carries ONE asset and ONE ticker. The second leg is real
    // disclosed text, so it belongs in the note — never a second row or ticker.
    expect(splitAssetNameDetail('Johnson & Johnson (Exchanged) Kenvue Inc.')).toEqual({
      name: 'Johnson & Johnson',
      note: 'exchanged for Kenvue Inc.',
    });
    expect(
      splitAssetNameDetail(
        'TCF Financial Corporation - Common Stock (Exchanged) Huntington Bancshares Incorporated - Common Stock (Received)',
      ),
    ).toEqual({
      name: 'TCF Financial Corporation',
      note: 'exchanged for Huntington Bancshares Incorporated - Common Stock',
    });
  });

  it('combines an exchange leg and a bond suffix into one note', () => {
    const out = splitAssetNameDetail(
      'Ysleta Texas Independent School District Ref Bond (Exchanged) Ysleta Texas Independent School District Ref Bond (Received) Rate/Coupon: 4.0% Matures: 08/15/2031',
    );
    expect(out.name).toBe('Ysleta Texas Independent School District Ref Bond');
    expect(out.note).toBe(
      'exchanged for Ysleta Texas Independent School District Ref Bond; coupon 4.0%, matures 08/15/2031',
    );
  });

  it('never trades a usable name for a note', () => {
    // Junk and suffix-only inputs fall back to the existing cleaner's answer.
    expect(splitAssetNameDetail('........................................')).toEqual({ name: '', note: null });
    expect(splitAssetNameDetail(null)).toEqual({ name: '', note: null });
    expect(splitAssetNameDetail('Rate/Coupon: 5.0% Matures: 05/01/2026').name).not.toBe('');
    expect(splitAssetNameDetail('ARCC ..', 'ARCC')).toEqual({ name: 'ARCC', note: null });
  });
});
