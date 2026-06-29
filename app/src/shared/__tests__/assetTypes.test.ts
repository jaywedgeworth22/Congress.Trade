import { describe, expect, it } from 'vitest';
import {
  assetTypeCategoryLabel,
  canonicalAssetTypeCategorySql,
  canonicalizeAssetType,
  houseAssetTypeCodePattern,
} from '../assetTypes';

describe('canonicalizeAssetType', () => {
  it('maps House codes and Senate labels into the same public equity category', () => {
    expect(canonicalizeAssetType('ST').category).toBe('public_equity');
    expect(canonicalizeAssetType('Stock').category).toBe('public_equity');
    expect(canonicalizeAssetType('ST').label).toBe('Stocks (including ADRs)');
  });

  it('maps government and municipal debt across chambers', () => {
    expect(canonicalizeAssetType('GS').category).toBe('fixed_income_government');
    expect(canonicalizeAssetType('Municipal Security').category).toBe('fixed_income_government');
    expect(canonicalizeAssetType('GS').categoryLabel).toBe('Government / Municipal Debt');
  });

  it('recognizes digit-prefixed retirement and 529 House codes', () => {
    for (const code of ['4K', '5C', '5F', '5P']) {
      expect(canonicalizeAssetType(code).category).toBe('retirement_or_529');
    }
  });

  it('keeps private/non-public equity distinct from public stock', () => {
    expect(canonicalizeAssetType('PS').category).toBe('private_equity');
    expect(canonicalizeAssetType('Non-Public Stock').category).toBe('private_equity');
  });

  it('falls back from explicit option flag when the raw type is missing', () => {
    expect(canonicalizeAssetType(null, null, { isOption: true }).category).toBe('option');
  });

  it('treats blank and PDF placeholder rows as unknown', () => {
    expect(canonicalizeAssetType(null).category).toBe('unknown');
    expect(canonicalizeAssetType('PDF Disclosed Filing').category).toBe('unknown');
    expect(assetTypeCategoryLabel('unknown')).toBe('Unknown');
  });

  it('exposes a House-code pattern that includes digit-prefixed codes', () => {
    const pattern = houseAssetTypeCodePattern();
    expect(new RegExp(`^(?:${pattern})$`).test('4K')).toBe(true);
    expect(new RegExp(`^(?:${pattern})$`).test('GS')).toBe(true);
  });
});

describe('canonicalAssetTypeCategorySql', () => {
  it('generates a SQL CASE expression for grouped analytics', () => {
    const sql = canonicalAssetTypeCategorySql('t.asset_type', 't.asset_type_name', 't.is_option');
    expect(sql).toContain("THEN 'public_equity'");
    expect(sql).toContain("THEN 'fixed_income_government'");
    expect(sql).toContain('t.is_option = 1');
  });
});
