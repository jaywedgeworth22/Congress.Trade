import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateBatchJobs, resolveBatchJobs } from '../batchCron.ts';
import type { Env } from '../../shared/types.ts';
import * as batchExtract from '../batchExtract.ts';
import * as db from '../../shared/db.ts';

vi.mock('../../shared/db', () => ({
  all: vi.fn(),
  run: vi.fn(),
  get: vi.fn(),
}));

vi.mock('../batchExtract', () => ({
  submitBatch: vi.fn(),
  pollBatch: vi.fn(),
}));

describe('batchCron', () => {
  let env: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    env = {
      DB: {} as any,
      RAW_FILES: {
        get: vi.fn().mockResolvedValue({
          arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(10)),
        }),
      } as any,
    } as unknown as Env;
  });

  describe('generateBatchJobs', () => {
    it('does nothing if no pending docs', async () => {
      vi.mocked(db.all).mockResolvedValueOnce([]);
      await generateBatchJobs(env);
      expect(batchExtract.submitBatch).not.toHaveBeenCalled();
    });

    it('submits a batch and updates DB', async () => {
      vi.mocked(db.all).mockResolvedValueOnce([
        { doc_id: 'doc1', chamber: 'house' },
      ]);
      vi.mocked(db.get).mockResolvedValueOnce({ raw_object_key: 'obj1' });
      vi.mocked(batchExtract.submitBatch).mockResolvedValueOnce('batch-123');

      await generateBatchJobs(env);

      expect(batchExtract.submitBatch).toHaveBeenCalledWith(
        env,
        'openai',
        'gpt-5.6-terra',
        expect.arrayContaining([
          expect.objectContaining({ docId: 'doc1', chamber: 'house' }),
        ])
      );
      expect(db.run).toHaveBeenCalledTimes(2); // INSERT into batch_jobs, DELETE from pending
    });
  });

  describe('resolveBatchJobs', () => {
    it('does nothing if no running/submitted jobs', async () => {
      vi.mocked(db.all).mockResolvedValueOnce([]);
      await resolveBatchJobs(env);
      expect(batchExtract.pollBatch).not.toHaveBeenCalled();
    });
  });
});
