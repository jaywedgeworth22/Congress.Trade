import { describe, expect, it, vi } from 'vitest';

vi.mock('./d1Budget', () => ({ recordD1Meta: vi.fn() }));

import { batchPrepared, first } from './db';
import { recordD1Meta } from './d1Budget';

describe('batchPrepared', () => {
  it('records D1 row metadata for every prepared-statement result', async () => {
    const statements = [{ run: vi.fn() }, { run: vi.fn() }] as unknown as D1PreparedStatement[];
    const db = {
      batch: vi.fn(async () => [
        { meta: { rows_read: 3, rows_written: 2 } },
        { meta: { rows_read: 5, rows_written: 7 } },
      ]),
    } as unknown as D1Database;

    await batchPrepared(db, statements);

    expect(recordD1Meta).toHaveBeenNthCalledWith(1, { rows_read: 3, rows_written: 2 });
    expect(recordD1Meta).toHaveBeenNthCalledWith(2, { rows_read: 5, rows_written: 7 });
  });
});

describe('first', () => {
  it('returns the first aggregate row and records D1 row metadata', async () => {
    const db = {
      prepare: vi.fn(() => ({
        all: vi.fn(async () => ({
          results: [{ total: 42 }],
          meta: { rows_read: 42, rows_written: 0 },
        })),
      })),
    } as unknown as D1Database;

    await expect(first<{ total: number }>(db, 'SELECT COUNT(*) AS total FROM transactions')).resolves.toEqual({ total: 42 });
    expect(recordD1Meta).toHaveBeenCalledWith({ rows_read: 42, rows_written: 0 });
  });
});
