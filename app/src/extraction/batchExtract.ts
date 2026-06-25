/**
 * src/extraction/batchExtract.ts
 *
 * Async **batch** extraction adapters for backlog reprocessing — ~50% cheaper
 * than the synchronous path, at the cost of async turnaround (minutes to 24h).
 * Used only for non-time-sensitive bulk work (e.g. draining the review queue),
 * never the live feed.
 *
 * Three providers, chosen for Worker-friendliness + PDF support in batch:
 *   - anthropic: Message Batches — inline request array, native base64 `document`
 *     block, no file pre-upload. The cleanest fit; typically <1h.
 *   - openai:    /v1/batches — requires a JSONL file upload first; each line is a
 *     /v1/chat/completions body with a base64 `file` part.
 *   - mistral:   /v1/batch/jobs over /v1/ocr — JSONL upload; cheapest per page.
 *
 * xAI is intentionally excluded: PDF-in-batch is undocumented (see research).
 *
 * Each provider exposes submit() (kick off, return the provider's batch id) and
 * poll() (status + decoded per-doc rows when finished). The per-line result
 * decoders are pure and unit-tested; the network plumbing mirrors bakeoff.ts.
 */

import type { Env, ParsedTx } from '../shared/types';
import { SYSTEM_PROMPT, parseModelJson, toParsedTx, arrayBufferToBase64 } from './visionLlm';
import { MISTRAL_ANNOTATION_SCHEMA, parseMistralOcrResponse } from './bakeoff';

export type BatchProvider = 'anthropic' | 'openai' | 'mistral';

/** A document to include in a batch: a stable id (its docId) + the raw PDF bytes. */
export interface BatchDoc {
  docId: string;
  bytes: ArrayBuffer;
}

/** One document's decoded result inside a finished batch. */
export interface BatchDocResult {
  docId: string;
  ok: boolean;
  error?: string;
  rows: ParsedTx[];
}

/** Poll outcome: still running, or finished (with per-doc results). */
export interface BatchPoll {
  done: boolean;
  failed: boolean;
  status: string;
  results: BatchDocResult[];
}

const PROMPT_OBJECT = `${SYSTEM_PROMPT}\nReturn a JSON object {"transactions": [...]} .`;
const PROMPT_ARRAY = `${SYSTEM_PROMPT}\nReturn ONLY the JSON array.`;

function keyFor(env: Env, provider: BatchProvider): string {
  const key =
    provider === 'anthropic' ? env.ANTHROPIC_API_KEY
    : provider === 'openai' ? env.OPENAI_API_KEY
    : env.MISTRAL_API_KEY;
  if (!key) throw new Error(`${provider} API key not configured`);
  return key;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 400);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Anthropic Message Batches — inline array, no upload.
// ---------------------------------------------------------------------------

function anthropicRequest(doc: BatchDoc, model: string): unknown {
  return {
    custom_id: doc.docId,
    params: {
      model,
      max_tokens: 8000,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: arrayBufferToBase64(doc.bytes) } },
            { type: 'text', text: PROMPT_ARRAY },
          ],
        },
      ],
    },
  };
}

async function submitAnthropic(env: Env, model: string, docs: BatchDoc[]): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages/batches', {
    method: 'POST',
    headers: { 'x-api-key': keyFor(env, 'anthropic'), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ requests: docs.map((d) => anthropicRequest(d, model)) }),
  });
  if (!res.ok) throw new Error(`anthropic batch create ${res.status} ${await safeText(res)}`);
  const j = (await res.json()) as { id?: string };
  if (!j.id) throw new Error('anthropic batch: no id');
  return j.id;
}

/** Decode one Anthropic batch result line to rows. Exported for tests. */
export function decodeAnthropicLine(line: unknown): BatchDocResult {
  const l = line as { custom_id?: string; result?: { type?: string; message?: { content?: Array<{ type: string; text?: string }> }; error?: unknown } };
  const docId = l.custom_id ?? '';
  if (l.result?.type !== 'succeeded' || !l.result.message) {
    return { docId, ok: false, error: JSON.stringify(l.result?.error ?? l.result?.type ?? 'failed').slice(0, 300), rows: [] };
  }
  try {
    const text = (l.result.message.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('').trim();
    return { docId, ok: true, rows: parseModelJson(text).map(toParsedTx) };
  } catch (err) {
    return { docId, ok: false, error: (err as Error).message.slice(0, 300), rows: [] };
  }
}

async function pollAnthropic(env: Env, batchId: string): Promise<BatchPoll> {
  const key = keyFor(env, 'anthropic');
  const headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  const res = await fetch(`https://api.anthropic.com/v1/messages/batches/${encodeURIComponent(batchId)}`, { headers });
  if (!res.ok) throw new Error(`anthropic batch get ${res.status} ${await safeText(res)}`);
  const j = (await res.json()) as { processing_status?: string; results_url?: string | null };
  if (j.processing_status !== 'ended' || !j.results_url) {
    return { done: false, failed: false, status: j.processing_status ?? 'unknown', results: [] };
  }
  const rj = await fetch(j.results_url, { headers });
  if (!rj.ok) throw new Error(`anthropic batch results ${rj.status}`);
  const results = parseJsonl(await rj.text()).map(decodeAnthropicLine);
  return { done: true, failed: false, status: 'ended', results };
}

// ---------------------------------------------------------------------------
// OpenAI /v1/batches — upload a JSONL of /v1/chat/completions requests first.
// ---------------------------------------------------------------------------

function openaiLine(doc: BatchDoc, model: string): string {
  const dataUrl = `data:application/pdf;base64,${arrayBufferToBase64(doc.bytes)}`;
  return JSON.stringify({
    custom_id: doc.docId,
    method: 'POST',
    url: '/v1/chat/completions',
    body: {
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'user', content: [
          { type: 'text', text: PROMPT_OBJECT },
          { type: 'file', file: { filename: 'ptr.pdf', file_data: dataUrl } },
        ] },
      ],
    },
  });
}

async function uploadJsonl(url: string, key: string, jsonl: string, extra: Record<string, string>): Promise<string> {
  const form = new FormData();
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  form.append('file', new Blob([jsonl], { type: 'application/jsonl' }), 'batch.jsonl');
  const res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form });
  if (!res.ok) throw new Error(`file upload ${res.status} ${await safeText(res)}`);
  const j = (await res.json()) as { id?: string };
  if (!j.id) throw new Error('file upload: no id');
  return j.id;
}

async function submitOpenAi(env: Env, model: string, docs: BatchDoc[]): Promise<string> {
  const key = keyFor(env, 'openai');
  const jsonl = docs.map((d) => openaiLine(d, model)).join('\n');
  const fileId = await uploadJsonl('https://api.openai.com/v1/files', key, jsonl, { purpose: 'batch' });
  const res = await fetch('https://api.openai.com/v1/batches', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ input_file_id: fileId, endpoint: '/v1/chat/completions', completion_window: '24h' }),
  });
  if (!res.ok) throw new Error(`openai batch create ${res.status} ${await safeText(res)}`);
  const j = (await res.json()) as { id?: string };
  if (!j.id) throw new Error('openai batch: no id');
  return j.id;
}

/** Decode one OpenAI batch output line to rows. Exported for tests. */
export function decodeOpenAiLine(line: unknown): BatchDocResult {
  const l = line as { custom_id?: string; response?: { status_code?: number; body?: { choices?: Array<{ message?: { content?: string } }> } }; error?: unknown };
  const docId = l.custom_id ?? '';
  const content = l.response?.body?.choices?.[0]?.message?.content;
  if (l.error || !content) {
    return { docId, ok: false, error: JSON.stringify(l.error ?? 'no content').slice(0, 300), rows: [] };
  }
  try {
    return { docId, ok: true, rows: parseModelJson(content).map(toParsedTx) };
  } catch (err) {
    return { docId, ok: false, error: (err as Error).message.slice(0, 300), rows: [] };
  }
}

async function pollOpenAi(env: Env, batchId: string): Promise<BatchPoll> {
  const key = keyFor(env, 'openai');
  const res = await fetch(`https://api.openai.com/v1/batches/${encodeURIComponent(batchId)}`, { headers: { authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`openai batch get ${res.status} ${await safeText(res)}`);
  const j = (await res.json()) as { status?: string; output_file_id?: string | null; error_file_id?: string | null };
  if (j.status === 'failed' || j.status === 'expired' || j.status === 'cancelled') {
    return { done: true, failed: true, status: j.status, results: [] };
  }
  if (j.status !== 'completed' || !j.output_file_id) {
    return { done: false, failed: false, status: j.status ?? 'unknown', results: [] };
  }
  const rj = await fetch(`https://api.openai.com/v1/files/${j.output_file_id}/content`, { headers: { authorization: `Bearer ${key}` } });
  if (!rj.ok) throw new Error(`openai batch results ${rj.status}`);
  const results = parseJsonl(await rj.text()).map(decodeOpenAiLine);
  return { done: true, failed: false, status: 'completed', results };
}

// ---------------------------------------------------------------------------
// Mistral /v1/batch/jobs over /v1/ocr — JSONL upload; cheapest per page.
// ---------------------------------------------------------------------------

function mistralLine(doc: BatchDoc): string {
  const dataUrl = `data:application/pdf;base64,${arrayBufferToBase64(doc.bytes)}`;
  return JSON.stringify({
    custom_id: doc.docId,
    body: {
      document: { type: 'document_url', document_url: dataUrl },
      document_annotation_format: { type: 'json_schema', json_schema: MISTRAL_ANNOTATION_SCHEMA },
      include_image_base64: false,
    },
  });
}

async function submitMistral(env: Env, model: string, docs: BatchDoc[]): Promise<string> {
  const key = keyFor(env, 'mistral');
  const jsonl = docs.map((d) => mistralLine(d)).join('\n');
  const fileId = await uploadJsonl('https://api.mistral.ai/v1/files', key, jsonl, { purpose: 'batch' });
  const res = await fetch('https://api.mistral.ai/v1/batch/jobs', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ input_files: [fileId], model, endpoint: '/v1/ocr' }),
  });
  if (!res.ok) throw new Error(`mistral batch create ${res.status} ${await safeText(res)}`);
  const j = (await res.json()) as { id?: string };
  if (!j.id) throw new Error('mistral batch: no id');
  return j.id;
}

/** Decode one Mistral batch output line to rows. Exported for tests. */
export function decodeMistralLine(line: unknown): BatchDocResult {
  const l = line as { custom_id?: string; response?: { body?: unknown }; body?: unknown; error?: unknown };
  const docId = l.custom_id ?? '';
  const body = (l.response && (l.response as { body?: unknown }).body) ?? l.body ?? l.response;
  if (l.error || body == null) {
    return { docId, ok: false, error: JSON.stringify(l.error ?? 'no body').slice(0, 300), rows: [] };
  }
  try {
    return { docId, ok: true, rows: parseMistralOcrResponse(body) };
  } catch (err) {
    return { docId, ok: false, error: (err as Error).message.slice(0, 300), rows: [] };
  }
}

async function pollMistral(env: Env, jobId: string): Promise<BatchPoll> {
  const key = keyFor(env, 'mistral');
  const res = await fetch(`https://api.mistral.ai/v1/batch/jobs/${encodeURIComponent(jobId)}`, { headers: { authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`mistral batch get ${res.status} ${await safeText(res)}`);
  const j = (await res.json()) as { status?: string; output_file?: string | null };
  const status = (j.status ?? 'UNKNOWN').toUpperCase();
  if (['FAILED', 'CANCELLED', 'TIMEOUT_EXCEEDED'].includes(status)) {
    return { done: true, failed: true, status, results: [] };
  }
  if (status !== 'SUCCESS' || !j.output_file) {
    return { done: false, failed: false, status, results: [] };
  }
  const rj = await fetch(`https://api.mistral.ai/v1/files/${j.output_file}/content`, { headers: { authorization: `Bearer ${key}` } });
  if (!rj.ok) throw new Error(`mistral batch results ${rj.status}`);
  const results = parseJsonl(await rj.text()).map(decodeMistralLine);
  return { done: true, failed: false, status: 'SUCCESS', results };
}

// ---------------------------------------------------------------------------
// Public dispatch + helpers
// ---------------------------------------------------------------------------

/** Split a JSONL blob into parsed objects, ignoring blank lines. Exported for tests. */
export function parseJsonl(text: string): unknown[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((v): v is unknown => v !== null);
}

export function isBatchProvider(v: unknown): v is BatchProvider {
  return v === 'anthropic' || v === 'openai' || v === 'mistral';
}

/** Submit a batch; returns the provider's batch/job id to poll later. */
export function submitBatch(env: Env, provider: BatchProvider, model: string, docs: BatchDoc[]): Promise<string> {
  if (provider === 'anthropic') return submitAnthropic(env, model, docs);
  if (provider === 'openai') return submitOpenAi(env, model, docs);
  return submitMistral(env, model, docs);
}

/** Poll a previously-submitted batch; when done, results carry decoded rows. */
export function pollBatch(env: Env, provider: BatchProvider, providerBatchId: string): Promise<BatchPoll> {
  if (provider === 'anthropic') return pollAnthropic(env, providerBatchId);
  if (provider === 'openai') return pollOpenAi(env, providerBatchId);
  return pollMistral(env, providerBatchId);
}
