/**
 * Shared instrument-type canonicalization.
 *
 * Keep raw disclosure values in transactions.asset_type / asset_type_name, then
 * compute this layer at read/export time so House bracket codes and Senate eFD
 * labels can roll up together without erasing provenance.
 */

import type { AssetTypeCategory } from '@jaywedgeworth22/congress-trading-shared';
export type { AssetTypeCategory };

export type AssetTypeSource = 'house_code' | 'label' | 'option_flag' | 'missing' | 'unknown';

export interface CanonicalAssetType {
  rawType: string | null;
  rawName: string | null;
  code: string | null;
  label: string;
  category: AssetTypeCategory;
  categoryLabel: string;
  source: AssetTypeSource;
}

export const HOUSE_ASSET_TYPE_NAMES: Record<string, string> = {
  '4K': '401K and Other Non-Federal Retirement Accounts',
  '5C': '529 College Savings Plan',
  '5F': '529 Portfolio',
  '5P': '529 Prepaid Tuition Plan',
  AB: 'Asset-Backed Securities',
  BA: 'Bank Accounts, Money Market Accounts and CDs',
  BK: 'Brokerage Accounts',
  CO: 'Collectibles',
  CS: 'Corporate Securities (Bonds and Notes)',
  CT: 'Cryptocurrency',
  DB: 'Defined Benefit Pension',
  DO: 'Debts Owed to the Filer',
  DS: 'Delaware Statutory Trust',
  EF: 'Exchange Traded Funds (ETF)',
  EQ: 'Excepted/Qualified Blind Trust',
  ET: 'Exchange Traded Notes',
  FA: 'Farms',
  FE: 'Foreign Exchange Position (Currency)',
  FN: 'Fixed Annuity',
  FU: 'Futures',
  GS: 'Government Securities and Agency Debt',
  HE: 'Hedge Funds & Private Equity Funds (EIF)',
  HN: 'Hedge Funds & Private Equity Funds (non-EIF)',
  IC: 'Investment Club',
  IH: 'IRA (Held in Cash)',
  IP: 'Intellectual Property & Royalties',
  IR: 'IRA',
  MA: 'Managed Accounts (e.g., SMA and UMA)',
  MF: 'Mutual Funds',
  MO: 'Mineral/Oil/Solar Energy Rights',
  OI: 'Ownership Interest (Holding Investments)',
  OL: 'Ownership Interest (Engaged in a Trade or Business)',
  OP: 'Options',
  OT: 'Other',
  PE: 'Pensions',
  PM: 'Precious Metals',
  PS: 'Stock (Not Publicly Traded)',
  RE: 'Real Estate Invest. Trust (REIT)',
  RF: 'REIT (EIF)',
  RN: 'REIT (non-EIF)',
  RP: 'Real Property',
  RS: 'Restricted Stock Units (RSUs)',
  SA: 'Stock Appreciation Right',
  ST: 'Stocks (including ADRs)',
  TR: 'Trust',
  VA: 'Variable Annuity',
  VI: 'Variable Insurance',
  WU: 'Whole/Universal Insurance',
};

export const HOUSE_ASSET_TYPE_CATEGORIES: Record<string, AssetTypeCategory> = {
  '4K': 'retirement_or_529',
  '5C': 'retirement_or_529',
  '5F': 'retirement_or_529',
  '5P': 'retirement_or_529',
  AB: 'fixed_income_asset_backed',
  BA: 'cash',
  BK: 'cash',
  CO: 'commodity_collectible',
  CS: 'fixed_income_corporate',
  CT: 'crypto',
  DB: 'retirement_or_529',
  DO: 'receivable',
  DS: 'trust',
  EF: 'fund',
  EQ: 'trust',
  ET: 'fund',
  FA: 'commodity_collectible',
  FE: 'derivative',
  FN: 'insurance_annuity',
  FU: 'derivative',
  GS: 'fixed_income_government',
  HE: 'private_fund',
  HN: 'private_fund',
  IC: 'business_interest',
  IH: 'retirement_or_529',
  IP: 'intellectual_property',
  IR: 'retirement_or_529',
  MA: 'fund',
  MF: 'fund',
  MO: 'commodity_collectible',
  OI: 'business_interest',
  OL: 'business_interest',
  OP: 'option',
  OT: 'other',
  PE: 'retirement_or_529',
  PM: 'commodity_collectible',
  PS: 'private_equity',
  RE: 'real_estate',
  RF: 'real_estate',
  RN: 'real_estate',
  RP: 'real_estate',
  RS: 'derivative',
  SA: 'derivative',
  ST: 'public_equity',
  TR: 'trust',
  VA: 'insurance_annuity',
  VI: 'insurance_annuity',
  WU: 'insurance_annuity',
};

export const ASSET_TYPE_CATEGORY_LABELS: Record<AssetTypeCategory, string> = {
  public_equity: 'Public Equity',
  private_equity: 'Private Equity',
  option: 'Options',
  fund: 'Funds / ETFs / REITs',
  fixed_income_government: 'Government / Municipal Debt',
  fixed_income_corporate: 'Corporate Debt',
  fixed_income_asset_backed: 'Asset-Backed Securities',
  cash: 'Cash / Bank Accounts',
  retirement_or_529: 'Retirement / 529 Accounts',
  real_estate: 'Real Estate',
  private_fund: 'Private Funds',
  business_interest: 'Business Interests',
  crypto: 'Crypto',
  insurance_annuity: 'Insurance / Annuities',
  trust: 'Trusts',
  commodity_collectible: 'Commodities / Collectibles',
  derivative: 'Derivatives / Rights',
  intellectual_property: 'Intellectual Property',
  receivable: 'Receivables',
  other_security: 'Other Securities',
  other: 'Other',
  unknown: 'Unknown',
};

const LABEL_CATEGORY_ALIASES: Record<string, AssetTypeCategory> = {
  '401k and other non federal retirement accounts': 'retirement_or_529',
  '401k and other non-federal retirement accounts': 'retirement_or_529',
  '529 college savings plan': 'retirement_or_529',
  '529 portfolio': 'retirement_or_529',
  '529 prepaid tuition plan': 'retirement_or_529',
  'asset backed securities': 'fixed_income_asset_backed',
  'asset-backed securities': 'fixed_income_asset_backed',
  'bank accounts money market accounts and cds': 'cash',
  'brokerage accounts': 'cash',
  cash: 'cash',
  cd: 'cash',
  cds: 'cash',
  collectibles: 'commodity_collectible',
  'corporate bond': 'fixed_income_corporate',
  'corporate bonds': 'fixed_income_corporate',
  'corporate debt': 'fixed_income_corporate',
  'corporate securities bonds and notes': 'fixed_income_corporate',
  cryptocurrency: 'crypto',
  crypto: 'crypto',
  'defined benefit pension': 'retirement_or_529',
  'debts owed to the filer': 'receivable',
  'delaware statutory trust': 'trust',
  'exchange traded funds etf': 'fund',
  etf: 'fund',
  'exchange traded notes': 'fund',
  etn: 'fund',
  'excepted qualified blind trust': 'trust',
  farms: 'commodity_collectible',
  'foreign exchange position currency': 'derivative',
  'fixed annuity': 'insurance_annuity',
  futures: 'derivative',
  'government securities and agency debt': 'fixed_income_government',
  'municipal security': 'fixed_income_government',
  muni: 'fixed_income_government',
  'government municipal debt': 'fixed_income_government',
  'hedge funds private equity funds eif': 'private_fund',
  'hedge funds private equity funds non eif': 'private_fund',
  'private fund': 'private_fund',
  'private funds': 'private_fund',
  'investment club': 'business_interest',
  'ira held in cash': 'retirement_or_529',
  ira: 'retirement_or_529',
  'intellectual property royalties': 'intellectual_property',
  'managed accounts e g sma and uma': 'fund',
  'managed accounts sma and uma': 'fund',
  'mutual funds': 'fund',
  'mutual fund': 'fund',
  'mineral oil solar energy rights': 'commodity_collectible',
  'ownership interest holding investments': 'business_interest',
  'ownership interest engaged in a trade or business': 'business_interest',
  option: 'option',
  options: 'option',
  'stock option': 'option',
  'other securities': 'other_security',
  other: 'other',
  pensions: 'retirement_or_529',
  pension: 'retirement_or_529',
  'precious metals': 'commodity_collectible',
  'stock not publicly traded': 'private_equity',
  'non public stock': 'private_equity',
  'non-public stock': 'private_equity',
  'real estate invest trust reit': 'real_estate',
  reit: 'real_estate',
  'reit eif': 'real_estate',
  'reit non eif': 'real_estate',
  'real property': 'real_estate',
  'restricted stock units rsus': 'derivative',
  rsu: 'derivative',
  rsus: 'derivative',
  'stock appreciation right': 'derivative',
  stock: 'public_equity',
  stocks: 'public_equity',
  'stocks including adrs': 'public_equity',
  equity: 'public_equity',
  trust: 'trust',
  'variable annuity': 'insurance_annuity',
  'variable insurance': 'insurance_annuity',
  'whole universal insurance': 'insurance_annuity',
};

const UNKNOWN_LABELS = new Set(['', 'unknown', 'pdf disclosed filing', 'n/a', 'n a', 'na', '--', '-']);

export function houseAssetTypeCodePattern(): string {
  return Object.keys(HOUSE_ASSET_TYPE_NAMES).sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
}

export function assetTypeCategoryLabel(category: AssetTypeCategory): string {
  return ASSET_TYPE_CATEGORY_LABELS[category] ?? ASSET_TYPE_CATEGORY_LABELS.unknown;
}

export function isAssetTypeCategory(value: string | null | undefined): value is AssetTypeCategory {
  return !!value && Object.prototype.hasOwnProperty.call(ASSET_TYPE_CATEGORY_LABELS, value);
}

export function canonicalizeAssetType(
  rawType: string | null | undefined,
  rawName?: string | null,
  opts?: { isOption?: boolean | null; assetName?: string | null },
): CanonicalAssetType {
  const type = cleanNullable(rawType);
  const name = cleanNullable(rawName);
  const upper = type?.toUpperCase() ?? null;

  if (upper && HOUSE_ASSET_TYPE_NAMES[upper]) {
    const category = HOUSE_ASSET_TYPE_CATEGORIES[upper] ?? 'other';
    return {
      rawType: type,
      rawName: name,
      code: upper,
      label: HOUSE_ASSET_TYPE_NAMES[upper],
      category,
      categoryLabel: assetTypeCategoryLabel(category),
      source: 'house_code',
    };
  }

  for (const value of [name, type, opts?.assetName ?? null]) {
    if (isUnknownAssetTypeValue(value)) {
      return canonical('unknown', type, name, value, 'missing');
    }
    const key = normalizeAssetTypeKey(value);
    if (!key) continue;
    const category = LABEL_CATEGORY_ALIASES[key];
    if (category) return canonical(category, type, name, value, 'label');
  }

  if (opts?.isOption) return canonical('option', type, name, type ?? name ?? 'Option', 'option_flag');
  if (!type && !name) return canonical('unknown', null, null, null, 'missing');
  return canonical('other', type, name, type ?? name, 'unknown');
}

export function canonicalAssetTypeCategorySql(
  rawTypeExpr: string,
  rawNameExpr = 'NULL',
  isOptionExpr?: string,
): string {
  const raw = `lower(trim(coalesce(${rawTypeExpr}, '')))`;
  const name = `lower(trim(coalesce(${rawNameExpr}, '')))`;
  const upper = `upper(trim(coalesce(${rawTypeExpr}, '')))`;
  const optionFlag = isOptionExpr ? `WHEN ${isOptionExpr} = 1 THEN 'option'` : '';
  const houseWhen = Object.entries(HOUSE_ASSET_TYPE_CATEGORIES)
    .map(([code, category]) => `WHEN ${upper} = ${sqlQuote(code)} THEN ${sqlQuote(category)}`)
    .join(' ');
  const houseLabelWhen = Object.entries(HOUSE_ASSET_TYPE_CATEGORIES)
    .map(([code, category]) => {
      const label = HOUSE_ASSET_TYPE_NAMES[code].toLowerCase();
      return `WHEN ${raw} = ${sqlQuote(label)} OR ${name} = ${sqlQuote(label)} THEN ${sqlQuote(category)}`;
    })
    .join(' ');
  const labelWhen = Object.entries(LABEL_CATEGORY_ALIASES)
    .map(
      ([label, category]) =>
        `WHEN ${raw} = ${sqlQuote(label)} OR ${name} = ${sqlQuote(label)} THEN ${sqlQuote(category)}`,
    )
    .join(' ');
  const unknownWhen = Array.from(UNKNOWN_LABELS)
    .filter(Boolean)
    .map((label) => `${raw} = ${sqlQuote(label)} OR ${name} = ${sqlQuote(label)}`)
    .join(' OR ');
  const unknownCase = unknownWhen ? `WHEN ${unknownWhen} THEN 'unknown'` : '';
  return `(CASE ${houseWhen} ${houseLabelWhen} ${labelWhen} ${unknownCase} ${optionFlag} WHEN ${raw} = '' AND ${name} = '' THEN 'unknown' ELSE 'other' END)`;
}

function canonical(
  category: AssetTypeCategory,
  rawType: string | null,
  rawName: string | null,
  label: string | null | undefined,
  source: AssetTypeSource,
): CanonicalAssetType {
  const categoryLabel = assetTypeCategoryLabel(category);
  return {
    rawType,
    rawName,
    code: null,
    label: cleanNullable(label) ?? categoryLabel,
    category,
    categoryLabel,
    source,
  };
}

function normalizeAssetTypeKey(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isUnknownAssetTypeValue(value: string | null | undefined): boolean {
  if (value == null) return false;
  const raw = value.trim().toLowerCase();
  if (UNKNOWN_LABELS.has(raw)) return true;
  const key = normalizeAssetTypeKey(value);
  return key ? UNKNOWN_LABELS.has(key) : false;
}

function cleanNullable(value: string | null | undefined): string | null {
  const cleaned = (value ?? '').trim();
  return cleaned ? cleaned : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
