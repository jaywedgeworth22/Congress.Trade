import { ClientTrade } from './contracts';

export interface ColumnDef {
  id: string;
  label: string;
  def: boolean; // default visible
  tier?: 'admin';
  tip?: string;
  sort?: string | null;
}


export const ALL_COLUMNS: ColumnDef[] = [
  { id: 'traded', label: 'Date Traded', def: true, tip: 'Date the trade was executed.', sort: 'txdate' },
  { id: 'type', label: 'Type', def: true, tip: 'Reported transaction type.', sort: 'type' },
  { id: 'member', label: 'Politician', def: true, tip: 'Politician who filed the disclosure.', sort: 'member' },
  { id: 'asset', label: 'Asset Type', def: true, tip: 'Asset name as reported.', sort: 'asset' },
  { id: 'amount', label: 'Amount', def: true, tip: 'STOCK Act bracket - an estimate, not an exact figure.', sort: 'min' },
  { id: 'sector', label: 'Sector', def: false, tip: 'Cross-referenced sector (FMP / SEC EDGAR).', sort: 'refSector' },
  { id: 'marketcap', label: 'Market Cap', def: true, tip: 'Market-cap size tier from enriched reference data.', sort: 'refMarketCap' },
  { id: 'country', label: 'Country', def: true, tip: 'Country of issue from enriched reference data.', sort: 'refCountry' },
  { id: 'published', label: 'Published', def: false, tip: 'When Congress.Trade first saw or imported the filing.', sort: 'published' },
  { id: 'lag', label: 'Lag', def: false, tip: 'Days between the trade and the filing (STOCK Act limit: 45).', sort: 'lag' },
  { id: 'filed', label: 'Official Filed', def: false, tip: 'Official disclosure/report date.', sort: 'filed' },
  { id: 'imported', label: 'Imported', def: true, tier: 'admin', tip: 'When Congress.Trade imported each filing.', sort: 'imported' },
  { id: 'latency', label: 'Latency', def: true, tier: 'admin', tip: 'Released to seen, then seen to imported for primary rows.', sort: null },
  { id: 'conf', label: 'Confidence', def: false, tier: 'admin', tip: 'Parser confidence after validation penalties.', sort: 'conf' },
  { id: 'owner', label: 'Owner', def: false, tip: 'Beneficial owner code reported on the filing.', sort: 'owner' },
  { id: 'chamber', label: 'Chamber', def: false, tip: 'House or Senate source chamber.', sort: 'chamber' },
  { id: 'source', label: 'Source', def: false, tier: 'admin', tip: 'Row provenance: primary official pipeline or historical seed import.', sort: 'source' },
  { id: 'docs', label: 'Documents', def: true, tip: 'Original PDF filing or source document.', sort: null },
];

const COL_HIDDEN_KEY = 'feed-cols-hidden-v3';
const COL_ORDER_KEY = 'feed-cols-order-v3';
const ADMIN_TOKEN_KEY = 'congresstrade.adminToken';

export function isAdminView(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return !!localStorage.getItem(ADMIN_TOKEN_KEY);
  } catch {
    return false;
  }
}

export function canUseColumn(c: ColumnDef, isAdmin: boolean): boolean {
  if (c.tier === 'admin') return isAdmin;
  return true;
}

export function loadColOrder(): string[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const v = JSON.parse(localStorage.getItem(COL_ORDER_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function saveColOrder(v: string[]) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(COL_ORDER_KEY, JSON.stringify(v));
  } catch {}
}

export function getOrderedColumns(isAdmin: boolean): ColumnDef[] {
  const available = ALL_COLUMNS.filter(c => canUseColumn(c, isAdmin));
  const order = loadColOrder();
  if (order.length === 0) return available;

  const pos: Record<string, number> = {};
  order.forEach((id, i) => { pos[id] = i; });

  return available.slice().sort((a, b) => {
    const ai = pos[a.id];
    const bi = pos[b.id];
    if (ai === undefined && bi === undefined) {
      return ALL_COLUMNS.findIndex(x => x.id === a.id) - ALL_COLUMNS.findIndex(x => x.id === b.id);
    }
    if (ai === undefined) return 1;
    if (bi === undefined) return -1;
    return ai - bi;
  });
}

export function defaultHidden(isAdmin: boolean): string[] {
  const available = ALL_COLUMNS.filter(c => canUseColumn(c, isAdmin));
  return available.filter(c => !c.def).map(c => c.id);
}

export function loadHiddenCols(isAdmin: boolean): string[] {
  if (typeof localStorage === 'undefined') return defaultHidden(isAdmin);
  try {
    const v = JSON.parse(localStorage.getItem(COL_HIDDEN_KEY) || 'null');
    return Array.isArray(v) ? v : defaultHidden(isAdmin);
  } catch {
    return defaultHidden(isAdmin);
  }
}

export function saveHiddenCols(h: string[]) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(COL_HIDDEN_KEY, JSON.stringify(h));
  } catch {}
}
