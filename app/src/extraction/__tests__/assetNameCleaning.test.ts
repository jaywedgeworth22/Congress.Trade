/**
 * src/extraction/__tests__/assetNameCleaning.test.ts
 *
 * Pins cleanAssetName(): which disclosure machinery moves out of the asset name
 * and into `transactions.cleaning_note`, and — just as important — which
 * look-alike text is deliberately LEFT ALONE.
 */

import { describe, expect, it } from 'vitest';
import { cleanAssetName, cleanAssetString } from '../nameNormalizer.ts';
import { plainCleaningNote } from '../../shared/cleaningNote.ts';

describe('cleanAssetName — House type codes', () => {
  it('strips a real House code and records why', () => {
    const r = cleanAssetName('TOBACCO SETTLEMENT FING CORP VA SER A1 TAXABLE SENIOR B/E CPN [CS] REDEMPTION');
    expect(r.name).not.toContain('[CS]');
    expect(r.name).toContain('Redemption');
    expect(r.note).toBe('removed disclosure type code from asset name');
    expect(r.ambiguous).toBeNull();
  });

  it('strips a repeated code and the [GS] government-securities code', () => {
    expect(cleanAssetName('Los Angeles, CA Tax & Revenue Anticipation Notes [GS]').name)
      .toBe('Los Angeles, CA Tax & Revenue Anticipation Notes');
    expect(cleanAssetName('Some Bond [CS] [CS]').name).toBe('Some Bond');
  });

  it('leaves a bracket token that is NOT a House code', () => {
    // "[Ahl/Pc]" is a share-class marker and "[15294% Interest]" is an
    // ownership percentage — neither is form plumbing we understand.
    expect(cleanAssetName('Aspen Insurance Holdings Ltd [Ahl/Pc]', 'AHL-C').name)
      .toContain('[Ahl/Pc]');
    expect(cleanAssetName('Lisa Family Investments LP [15294% Interest]').name)
      .toContain('[15294% Interest]');
  });

  it('no longer leaves an unbalanced bracket behind', () => {
    // Regression: the trailing-"]" OCR strip used to fire on real bracketed
    // suffixes and produce "Aspen Insurance Holdings Ltd. [Ahl/Pc".
    expect(cleanAssetName('Aspen Insurance Holdings Ltd [Ahl/Pc]', 'AHL-C').name)
      .not.toMatch(/\[[^\]]*$/);
  });
});

describe('cleanAssetName — footnote markers', () => {
  it('strips a trailing footnote marker chain', () => {
    const r = cleanAssetName('US TREASURY BILLS DUE 04/01/2021 [1][2]');
    expect(r.name).toBe('Us Treasury Bills');
    expect(r.note).toBe('removed filing footnote markers from asset name; matures 04/01/2021');
  });

  it('strips a single marker but keeps the muni name intact', () => {
    const r = cleanAssetName('Georgia ST GEN Auth REV 06/01/2030 5.000% [1]');
    expect(r.name).toBe('Georgia ST GEN Auth REV 06/01/2030 5.000%');
    expect(r.note).toBe('removed filing footnote markers from asset name');
  });
});

describe('cleanAssetName — Senate eFD rigid instrument suffix', () => {
  it('moves "Rate/Coupon: X% Matures: DATE" into the note', () => {
    const r = cleanAssetName('Owens & Minor Rate/Coupon: 3.875% Matures: 09/15/2021');
    expect(r.name).toBe('Owens & Minor');
    expect(r.note).toBe('3.875% coupon, matures 09/15/2021');
    expect(r.ambiguous).toBeNull();
  });

  it('handles the rate-only and matures-only halves', () => {
    expect(cleanAssetName('Dominion Energy Rate/Coupon: 2.579%').note).toBe('2.579% coupon');
    expect(cleanAssetName('Dominion Energy Matures: 07/01/2020').note).toBe('matures 07/01/2020');
  });

  it('moves the trailing "N% due DATE" variant into the note', () => {
    const r = cleanAssetName('Block Financial 5.125% due 10/30/2014');
    expect(r.name).toBe('Block Financial');
    expect(r.note).toBe('5.125% coupon, matures 10/30/2014');
  });

  it('moves the trailing "DUE DATE N%" variant into the note', () => {
    const r = cleanAssetName('Michigan ST Trunk Line DUE 11/15/2035 5.000%');
    expect(r.name).toBe('Michigan ST Trunk Line');
    expect(r.note).toBe('5.000% coupon, matures 11/15/2035');
  });

  // KNOWN LIMIT, pinned deliberately. After the rigid suffix comes off, the
  // inline "5% 04/01/27" is genuinely part of how this muni is identified —
  // there is no keyword to anchor on, so we do not guess.
  it('leaves the inline muni rate/date that survives the rigid suffix', () => {
    const r = cleanAssetName(
      'Carroll Cnty Ga SCH Dist Go 5% 04/01/27 Ao (Muni) Rate/Coupon: 5.0% Matures: 04/01/2027',
    );
    expect(r.name).toContain('5% 04/01/27');
    expect(r.note).toBe('5.0% coupon, matures 04/01/2027');
    // ("(Muni)" is dropped by cleanAssetString's pre-existing trailing
    // "(EXCHANGE)" rule, which is a separate false positive — see the report.)
  });

  it('leaves a bare trailing rate with no due/matures keyword', () => {
    const r = cleanAssetName('Florida ST BRD of Educ PUB EDU CAP Outlay 1.80%');
    expect(r.name).toContain('1.80%');
    expect(r.note).toBeNull();
  });

  it('leaves a bare trailing date with no due/matures keyword', () => {
    const r = cleanAssetName('Chicago IL MTN WTR Reclamation Dist 10/01/2035 3.000%');
    expect(r.name).toContain('10/01/2035');
    expect(r.note).toBeNull();
  });
});

describe('cleanAssetName — exchange legs', () => {
  it('names the leg given up and notes the leg received', () => {
    const r = cleanAssetName('Praxair, Inc. (Exchanged) Linde plc', 'PX');
    expect(r.name).toBe('Praxair, Inc.');
    expect(r.note).toBe('exchanged for Linde plc');
    expect(r.ambiguous).toBeNull();
  });

  it('drops the trailing "(Received)" marker off the second leg', () => {
    const r = cleanAssetName(
      'Ysleta Texas Independent School District Ref Bond (Exchanged) ' +
        'Ysleta Texas Independent School District Ref Bond (Received) Rate/Coupon: 4.0% Matures: 08/15/2031',
    );
    expect(r.name).toBe('Ysleta Texas Independent School District Ref Bond');
    expect(r.note).toBe(
      '4.0% coupon, matures 08/15/2031; exchanged for Ysleta Texas Independent School District Ref Bond',
    );
  });

  it('flags an exchange whose leg is a bare symbol rather than a company name', () => {
    const r = cleanAssetName('CVG (Exchanged) SNX');
    expect(r.ambiguous).toBe('exchange leg is a bare symbol, not a company name');
  });
});

describe('cleanAssetName — safety', () => {
  it('is a no-op on an already-clean name', () => {
    const r = cleanAssetName('Microsoft Corporation', 'MSFT');
    expect(r.name).toBe('Microsoft Corporation');
    expect(r.note).toBeNull();
    expect(r.ambiguous).toBeNull();
  });

  it('is idempotent — a second pass changes nothing and adds no note', () => {
    const first = cleanAssetName('Owens & Minor Rate/Coupon: 3.875% Matures: 09/15/2021');
    const second = cleanAssetName(first.name);
    expect(second.name).toBe(first.name);
    expect(second.note).toBeNull();
  });

  it('refuses to strip a name down to nothing', () => {
    const r = cleanAssetName('[GS]');
    expect(r.ambiguous).toBe('stripping would leave an empty asset name');
    expect(r.note).toBeNull();
  });

  it('keeps cleanAssetString behaviour unchanged for existing callers', () => {
    expect(cleanAssetString('ARCC ..', 'ARCC')).toBe('ARCC');
    expect(cleanAssetString('Microsoft Corporation', 'MSFT')).toBe('Microsoft Corporation');
  });
});

describe('plainCleaningNote passes the new notes through unchanged', () => {
  it('round-trips every note shape cleanAssetName can emit', () => {
    for (const note of [
      'removed disclosure type code from asset name',
      'removed filing footnote markers from asset name',
      '3.875% coupon, matures 09/15/2021',
      '2.579% coupon',
      'matures 07/01/2020',
      'exchanged for Linde plc',
      'removed filing footnote markers from asset name; matures 04/01/2021',
    ]) {
      expect(plainCleaningNote(note)).toBe(note);
    }
  });
});
