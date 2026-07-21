import { Env, Filing, Chamber } from '../shared/types.ts';
import { all, run, get } from '../shared/db.ts';
import { submitBatch, pollBatch, BatchDoc } from './batchExtract.ts';
import { normalize } from './normalizer.ts';

const MAX_BATCH_SIZE = 1000;

interface FilingRow {
  doc_id: string;
  chamber: string | null;
  filer_id: string | null;
  filing_type: string | null;
  filed_date: string | null;
  source_url: string | null;
  raw_object_key: string | null;
  ingest_status: string | null;
  doc_kind: string | null;
  extractor: string | null;
  model_version: string | null;
  confidence: number | null;
  first_seen_at: string | null;
  source_updated_at: string | null;
  error: string | null;
}

function rowToFiling(r: FilingRow): Filing {
  return {
    docId: r.doc_id,
    chamber: (r.chamber as Chamber) ?? 'house',
    filerId: r.filer_id ?? '',
    filingType: r.filing_type ?? 'PTR',
    filedDate: r.filed_date ?? '',
    sourceUrl: r.source_url ?? '',
    rawObjectKey: r.raw_object_key ?? '',
    ingestStatus: (r.ingest_status as Filing['ingestStatus']) ?? 'new',
    docKind: (r.doc_kind as Filing['docKind']) ?? 'unknown',
    extractor: r.extractor ?? null,
    modelVersion: r.model_version ?? null,
    confidence: r.confidence ?? null,
    firstSeenAt: r.first_seen_at ?? '',
    sourceUpdatedAt: r.source_updated_at ?? null,
    error: r.error ?? null,
  };
}

export async function generateBatchJobs(env: Env): Promise<void> {
  // 1. Pull up to MAX_BATCH_SIZE docs
  const rows = await all<{ doc_id: string; chamber: string }>(
    env.DB,
    `SELECT doc_id, chamber FROM batch_extractions_pending ORDER BY enqueued_at ASC LIMIT ?`,
    [MAX_BATCH_SIZE]
  );
  if (rows.length === 0) return;

  const docs: BatchDoc[] = [];
  for (const row of rows) {
    const rawRow = await get<{ raw_object_key: string }>(
      env.DB,
      `SELECT raw_object_key FROM filings WHERE doc_id = ?`,
      [row.doc_id]
    );
    const key = rawRow?.raw_object_key;
    if (!key) continue;

    const obj = await env.RAW_FILES.get(key);
    if (!obj) continue;
    
    docs.push({
      docId: row.doc_id,
      chamber: row.chamber as any,
      bytes: await obj.arrayBuffer()
    });
  }

  if (docs.length === 0) {
    // Delete the pending rows since we failed to find their objects
    const docIds = rows.map(r => r.doc_id);
    await run(
      env.DB,
      `DELETE FROM batch_extractions_pending WHERE doc_id IN (${docIds.map(() => '?').join(',')})`,
      docIds
    );
    return;
  }

  const provider = 'openai';
  const model = 'gpt-5.6-terra'; // the default live model

  try {
    const batchId = await submitBatch(env, provider, model, docs);
    const docIdsJson = JSON.stringify(docs.map(d => d.docId));
    
    await run(
      env.DB,
      `INSERT INTO batch_jobs (id, provider, model, provider_batch_id, doc_ids, status, submitted_at)
       VALUES (?, ?, ?, ?, ?, 'submitted', ?)`,
      [
        crypto.randomUUID(), provider, model, batchId, docIdsJson, new Date().toISOString()
      ]
    );
    
    const docIds = rows.map(r => r.doc_id); // include the ones we skipped so they aren't stuck
    await run(
      env.DB,
      `DELETE FROM batch_extractions_pending WHERE doc_id IN (${docIds.map(() => '?').join(',')})`,
      docIds
    );
  } catch (err) {
    console.error('generateBatchJobs failed:', err);
  }
}

export async function resolveBatchJobs(env: Env): Promise<void> {
  const jobs = await all<{ id: string; provider: string; provider_batch_id: string }>(
    env.DB,
    `SELECT id, provider, provider_batch_id FROM batch_jobs WHERE status IN ('submitted', 'running')`
  );

  for (const job of jobs) {
    try {
      const poll = await pollBatch(env, job.provider as any, job.provider_batch_id);
      
      const now = new Date().toISOString();
      const status = poll.status;
      
      if (status === 'completed') {
        const resultSummary = {
           docs: poll.results.length,
           ok: poll.results.filter(r => r.ok).length,
           rows: poll.results.reduce((acc, r) => acc + (r.rows?.length || 0), 0),
           errors: poll.providerErrors || []
        };
        await run(
          env.DB,
          `UPDATE batch_jobs SET status = 'completed', completed_at = ?, turnaround_ms = ?, result_summary = ? WHERE id = ?`,
          [
             poll.terminalAt || now, 
             poll.terminalAt && poll.submittedAt ? new Date(poll.terminalAt).getTime() - new Date(poll.submittedAt).getTime() : null,
             JSON.stringify(resultSummary),
             job.id
          ]
        );
        
        for (const doc of poll.results) {
           if (doc.ok && doc.rows) {
              const fRow = await get<FilingRow>(
                env.DB,
                `SELECT * FROM filings WHERE doc_id = ?`,
                [doc.docId]
              );
              if (fRow) {
                await normalize(env, rowToFiling(fRow), doc.rows, {
                  extractor: job.provider,
                  modelVersion: 'batch'
                });
              }
           } else if (doc.error) {
              await run(env.DB, `UPDATE filings SET error = ? WHERE doc_id = ?`, [doc.error, doc.docId]);
           }
        }
      } else if (status === 'failed') {
         await run(
           env.DB,
           `UPDATE batch_jobs SET status = 'failed', completed_at = ?, error = ? WHERE id = ?`,
           [now, JSON.stringify(poll.providerErrors), job.id]
         );
      } else if (status === 'running') {
         await run(env.DB, `UPDATE batch_jobs SET status = 'running' WHERE id = ?`, [job.id]);
      }
    } catch (err) {
      console.error(`pollBatch failed for job ${job.id}:`, err);
    }
  }
}
