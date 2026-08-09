import { describe, it, expect } from 'vitest';
import { plainCleaningNote } from '../cleaningNote.ts';

describe('plainCleaningNote', () => {
  it('maps securities_ref populate notes to a concise fragment', () => {
    expect(plainCleaningNote('Populated official company name from securities_ref')).toBe(
      'asset name derived from ticker',
    );
    expect(plainCleaningNote('asset name derived from ticker')).toBe('asset name derived from ticker');
  });

  it('maps OCR audit strings without title case or Original: payloads', () => {
    expect(plainCleaningNote('Cleaned OCR dot leader noise (Original: ......)')).toBe(
      'cleaned OCR noise from asset name',
    );
    expect(plainCleaningNote('Stripped OCR dot leader suffix (Original: ARCC ....)')).toBe(
      'removed OCR noise from asset name',
    );
    expect(plainCleaningNote('Cleaned junk OCR text (Original: ....foo)')).toBe(
      'removed junk OCR from asset name',
    );
  });

  it('passes through empty and unknown notes', () => {
    expect(plainCleaningNote(null)).toBe('');
    expect(plainCleaningNote('')).toBe('');
    expect(plainCleaningNote('  ')).toBe('');
    expect(plainCleaningNote('some custom operator note')).toBe('some custom operator note');
  });
});
