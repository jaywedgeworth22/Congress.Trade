import { describe, expect, it, vi } from 'vitest';

vi.mock('./d1Budget', () => ({ recordD1Meta: vi.fn() }));

import { batchPrepared } from './db';
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
