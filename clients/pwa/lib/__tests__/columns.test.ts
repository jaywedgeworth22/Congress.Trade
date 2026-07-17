import { describe, expect, it, beforeEach } from 'vitest';
import {
  ALL_COLUMNS,
  canUseColumn,
  loadColOrder,
  saveColOrder,
  getOrderedColumns,
  loadHiddenCols,
  saveHiddenCols,
  defaultHidden,
} from '../columns';

class LocalStorageMock {
  private store: Record<string, string> = {};

  clear() {
    this.store = {};
  }

  getItem(key: string) {
    return this.store[key] || null;
  }

  setItem(key: string, value: string) {
    this.store[key] = String(value);
  }

  removeItem(key: string) {
    delete this.store[key];
  }
}

if (typeof globalThis.localStorage === 'undefined') {
  globalThis.localStorage = new LocalStorageMock() as unknown as Storage;
}

describe('PWA column utilities', () => {
  beforeEach(() => {
    globalThis.localStorage.clear();
  });

  it('determines visibility based on user tiers', () => {
    const tradedCol = ALL_COLUMNS.find(c => c.id === 'traded')!;
    const sectorCol = ALL_COLUMNS.find(c => c.id === 'sector')!;
    const latencyCol = ALL_COLUMNS.find(c => c.id === 'latency')!;

    // Traded is public
    expect(canUseColumn(tradedCol, false, false)).toBe(true);

    // Sector is public (no longer premium)
    expect(canUseColumn(sectorCol, false, false)).toBe(true);

    // Latency is admin
    expect(canUseColumn(latencyCol, true, false)).toBe(false);
    expect(canUseColumn(latencyCol, false, true)).toBe(true);
  });

  it('saves and loads column order', () => {
    const mockOrder = ['asset', 'traded', 'type'];
    saveColOrder(mockOrder);
    expect(loadColOrder()).toEqual(mockOrder);
  });

  it('returns ordered columns based on preferences', () => {
    const premiumOrder = getOrderedColumns(true, false);
    expect(premiumOrder.length).toBeLessThan(ALL_COLUMNS.length); // admin cols excluded

    const mockOrder = ['asset', 'traded'];
    saveColOrder(mockOrder);

    const ordered = getOrderedColumns(true, false);
    expect(ordered[0].id).toBe('asset');
    expect(ordered[1].id).toBe('traded');
  });

  it('saves and loads hidden columns', () => {
    const mockHidden = ['published', 'lag'];
    saveHiddenCols(mockHidden);
    expect(loadHiddenCols(false, false)).toEqual(mockHidden);
  });

  it('falls back to default hidden columns when localStorage is empty', () => {
    const defaults = defaultHidden(false, false);
    expect(loadHiddenCols(false, false)).toEqual(defaults);
  });
});
