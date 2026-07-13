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
import { HOUSE_SYSTEM_PROMPT, SENATE_SYSTEM_PROMPT, EXECUTIVE_SYSTEM_PROMPT, parseModelJson, toParsedTx, arrayBufferToBase64 } from './visionLlm';
import { MISTRAL_ANNOTATION_SCHEMA, parseMistralOcrResponse, extractXaiResponseText } from './bakeoff';
import { resolveSecret } from '../secrets/infisical';

export type BatchProvider = 'anthropic' | 'openai' | 'mistral' | 'xai';

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

function getPrompt(chamber: string): string {
  if (chamber === 'senate') return SENATE_SYSTEM_PROMPT;
  if (chamber === 'executive') return EXECUTIVE_SYSTEM_PROMPT;
  return HOUSE_SYSTEM_PROMPT;
}

function getPromptObject(chamber: string): string {
  return `${getPrompt(chamber)}\nReturn a JSON object {"transactions": [...]} .`;
}

function getPromptArray(chamber: string): string {
  return `${getPrompt(chamber)}\nReturn ONLY the JSON array.`;
}

function getChamber(docId: string): string {
  if (docId.startsWith('S-')) return 'senate';
  if (docId.startsWith('E-')) return 'executive';
  return 'house';
}

async function keyFor(env: Env, provider: BatchProvider): Promise<string> {
  const key =
    provider === 'anthropic' ? (await resolveSecret(env, 'ANTHROPIC_API_KEY')).value
    : provider === 'openai' ? (await resolveSecret(env, 'OPENAI_API_KEY')).value
    : provider === 'xai' ? (await resolveSecret(env, 'XAI_API_KEY')).value
    : (await resolveSecret(env, 'MISTRAL_API_KEY')).value;
  if (!key) throw new Error(`${provider} API key not configured`);
  return key;
}

/** Upload one PDF to a provider's Files API; returns the file id to reference. */
async function uploadPdf(url: string, key: string, bytes: ArrayBuffer, purpose: string): Promise<string> {
  const form = new FormData();
  form.append('purpose', purpose);
  form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'ptr.pdf');
  const res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form });
  if (!res.ok) throw new Error(`pdf upload ${res.status} ${await safeText(res)}`);
  const j = (await res.json()) as { id?: string };
  if (!j.id) throw new Error('pdf upload: no id');
  return j.id;
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
            { type: 'text', text: getPromptArray(getChamber(doc.docId)) },
          ],
        },
      ],
    },
  };
}

async function submitAnthropic(env: Env, model: string, docs: BatchDoc[]): Promise<string> {
  const key = await keyFor(env, 'anthropic');
  const res = await fetch('https://api.anthropic.com/v1/messages/batches', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
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
  const key = await keyFor(env, 'anthropic');
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

// OpenAI Batch does NOT accept inline base64 in a JSONL line — each PDF must be
// uploaded to the Files API first and referenced by file_id (inline base64 is
// sync-only). So a line carries a `{type:'file', file:{file_id}}` content part.
function openaiLine(docId: string, fileId: string, model: string): string {
  return JSON.stringify({
    custom_id: docId,
    method: 'POST',
    url: '/v1/chat/completions',
    body: {
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'user', content: [
          { type: 'text', text: getPromptObject(getChamber(docId)) },
          { type: 'file', file: { file_id: fileId } },
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
  const key = await keyFor(env, 'openai');
  // 1) upload each PDF to the Files API (purpose=user_data) → file_id.
  const lines: string[] = [];
  for (const d of docs) {
    const fileId = await uploadPdf('https://api.openai.com/v1/files', key, d.bytes, 'user_data');
    lines.push(openaiLine(d.docId, fileId, model));
  }
  // 2) upload the JSONL of requests (purpose=batch) → input file.
  const fileId = await uploadJsonl('https://api.openai.com/v1/files', key, lines.join('\n'), { purpose: 'batch' });
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
  const key = await keyFor(env, 'openai');
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
  const key = await keyFor(env, 'mistral');
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
  const key = await keyFor(env, 'mistral');
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
// xAI Grok — upload each PDF to the Files API, create an empty batch, then add
// `responses` requests that reference the file by id. Distinct shape: poll
// state.num_pending; results are paginated. Mirrors the working sync adapter.
// ---------------------------------------------------------------------------

async function submitXai(env: Env, model: string, docs: BatchDoc[]): Promise<string> {
  const key = await keyFor(env, 'xai');
  // 1) upload each PDF → file id.
  const uploads: Array<{ docId: string; fileId: string }> = [];
  for (const d of docs) {
    uploads.push({ docId: d.docId, fileId: await uploadPdf('https://api.x.ai/v1/files', key, d.bytes, 'assistants') });
  }
  // 2) create an empty batch.
  const cr = await fetch('https://api.x.ai/v1/batches', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'congress-backlog' }),
  });
  if (!cr.ok) throw new Error(`xai batch create ${cr.status} ${await safeText(cr)}`);
  const cj = (await cr.json()) as { id?: string; batch_id?: string };
  const batchId = cj.id ?? cj.batch_id;
  if (!batchId) throw new Error('xai batch: no id');
  // 3) add a request per document referencing its uploaded file.
  const batch_requests = uploads.map((u) => ({
    batch_request_id: u.docId,
    batch_request: {
      responses: {
        model,
        input: [
          { role: 'user', content: [
            { type: 'input_text', text: getPromptObject(getChamber(u.docId)) },
            { type: 'input_file', file_id: u.fileId },
          ] },
        ],
      },
    },
  }));
  const ar = await fetch(`https://api.x.ai/v1/batches/${encodeURIComponent(batchId)}/requests`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ batch_requests }),
  });
  if (!ar.ok) throw new Error(`xai batch add-requests ${ar.status} ${await safeText(ar)}`);
  return batchId;
}

/** Decode one xAI batch result item to rows. Exported for tests. */
export function decodeXaiResult(item: unknown): BatchDocResult {
  const l = item as {
    batch_request_id?: string;
    batch_result?: { response?: { chat_get_completion?: { choices?: Array<{ message?: { content?: string } }> }; responses?: unknown }; error?: unknown };
    error?: unknown;
  };
  const docId = l.batch_request_id ?? '';
  const resp = l.batch_result?.response;
  if ((l.error || l.batch_result?.error) ?? !resp) {
    return { docId, ok: false, error: JSON.stringify(l.error ?? l.batch_result?.error ?? 'no response').slice(0, 300), rows: [] };
  }
  try {
    let text = '';
    if (resp?.chat_get_completion) text = resp.chat_get_completion.choices?.[0]?.message?.content ?? '';
    else if (resp?.responses) text = extractXaiResponseText(resp.responses);
    if (!text) return { docId, ok: false, error: 'no content in result', rows: [] };
    return { docId, ok: true, rows: parseModelJson(text).map(toParsedTx) };
  } catch (err) {
    return { docId, ok: false, error: (err as Error).message.slice(0, 300), rows: [] };
  }
}

async function pollXai(env: Env, batchId: string): Promise<BatchPoll> {
  const key = await keyFor(env, 'xai');
  const headers = { authorization: `Bearer ${key}` };
  const res = await fetch(`https://api.x.ai/v1/batches/${encodeURIComponent(batchId)}`, { headers });
  if (!res.ok) throw new Error(`xai batch get ${res.status} ${await safeText(res)}`);
  const j = (await res.json()) as { state?: { num_pending?: number; num_requests?: number; num_error?: number } };
  const pending = j.state?.num_pending;
  if (typeof pending !== 'number') return { done: false, failed: false, status: 'unknown', results: [] };
  if (pending > 0) return { done: false, failed: false, status: `pending ${pending}/${j.state?.num_requests ?? '?'}`, results: [] };
  // pending === 0 → paginate the results.
  const results: BatchDocResult[] = [];
  let token: string | null = null;
  do {
    const url = `https://api.x.ai/v1/batches/${encodeURIComponent(batchId)}/results?limit=100` + (token ? `&pagination_token=${encodeURIComponent(token)}` : '');
    const rr: Response = await fetch(url, { headers });
    if (!rr.ok) throw new Error(`xai batch results ${rr.status}`);
    const rj = (await rr.json()) as { results?: unknown[]; batch_results?: unknown[]; data?: unknown[]; pagination_token?: string | null };
    for (const it of rj.results ?? rj.batch_results ?? rj.data ?? []) results.push(decodeXaiResult(it));
    token = rj.pagination_token ?? null;
  } while (token);
  return { done: true, failed: false, status: 'completed', results };
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
  return v === 'anthropic' || v === 'openai' || v === 'mistral' || v === 'xai';
}

/** Submit a batch; returns the provider's batch/job id to poll later. */
export function submitBatch(env: Env, provider: BatchProvider, model: string, docs: BatchDoc[]): Promise<string> {
  if (provider === 'anthropic') return submitAnthropic(env, model, docs);
  if (provider === 'openai') return submitOpenAi(env, model, docs);
  if (provider === 'xai') return submitXai(env, model, docs);
  return submitMistral(env, model, docs);
}

/** Poll a previously-submitted batch; when done, results carry decoded rows. */
export function pollBatch(env: Env, provider: BatchProvider, providerBatchId: string): Promise<BatchPoll> {
  if (provider === 'anthropic') return pollAnthropic(env, providerBatchId);
  if (provider === 'openai') return pollOpenAi(env, providerBatchId);
  if (provider === 'xai') return pollXai(env, providerBatchId);
  return pollMistral(env, providerBatchId);
}
