/**
 * src/extraction/bakeoff.ts
 *
 * Provider-neutral extraction bake-off. Runs the SAME House PTR PDFs through
 * several vision models (Gemini, OpenAI, Anthropic) using one shared prompt, so
 * we can compare extraction quality before committing the whole House corpus to
 * one model. Each provider is a thin raw-`fetch` adapter (matching the existing
 * visionLlm.ts style — no SDK in the Worker); the shared JSON parser turns every
 * provider's reply into ParsedTx[].
 *
 * Without a hand-labelled answer key we can't score absolute accuracy, so the
 * harness reports the signals that ARE measurable per model: row recall (rows
 * found), malformed-JSON / API failures, latency, and cross-model agreement
 * (how much each model's rows line up with the consensus). The pure aggregation
 * helpers (summarizeModels / computeConsensusAgreement) are unit-tested.
 */

import type { Env, ParsedTx } from '../shared/types';
import { arbitrationRowKey } from '../extractors/types';
import {
  SYSTEM_PROMPT,
  parseModelJson,
  toParsedTx,
  arrayBufferToBase64,
  VisionLlmExtractor,
} from './visionLlm';

export type Provider = 'gemini' | 'openai' | 'anthropic';

export interface BakeoffCandidate {
  provider: Provider;
  model: string;
}

/** Provider-neutral default lineup (overridable per request). */
export const DEFAULT_CANDIDATES: BakeoffCandidate[] = [
  { provider: 'gemini', model: 'gemini-3.5-flash' },
  { provider: 'openai', model: 'gpt-4o' },
  { provider: 'openai', model: 'gpt-4o-mini' },
  { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  { provider: 'anthropic', model: 'claude-haiku-4-5' },
];

/** One model's run over one document. */
export interface CandidateDocResult {
  provider: Provider;
  model: string;
  docId: string;
  ok: boolean;
  error?: string;
  latencyMs: number;
  rowCount: number;
  /** Stable row keys (ticker/name|date|type) for agreement scoring. */
  rowKeys: string[];
}

/** Per-model rollup across all documents. */
export interface ModelSummary {
  provider: Provider;
  model: string;
  label: string;
  docsAttempted: number;
  docsOk: number;
  failures: number;
  totalRows: number;
  avgRowsPerOkDoc: number;
  avgLatencyMs: number;
  /** Mean fraction of the per-doc consensus rows this model recovered, [0,1]. */
  consensusAgreement: number;
}

const label = (c: { provider: Provider; model: string }): string => `${c.provider}:${c.model}`;

// ---------------------------------------------------------------------------
// Provider adapters — each returns the raw model reply text (a JSON array).
// ---------------------------------------------------------------------------

/** Resolve the API key for a provider, or null when it isn't configured. */
function keyFor(env: Env, provider: Provider): string | null {
  if (provider === 'gemini') return env.GEMINI_API_KEY ?? null;
  if (provider === 'openai') return env.OPENAI_API_KEY ?? null;
  if (provider === 'anthropic') return env.ANTHROPIC_API_KEY ?? null;
  return null;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 400);
  } catch {
    return '';
  }
}

/** OpenAI chat-completions vision call (PDF as a base64 data URL `file` part). */
async function runOpenAi(model: string, key: string, bytes: ArrayBuffer): Promise<ParsedTx[]> {
  const dataUrl = `data:application/pdf;base64,${arrayBufferToBase64(bytes)}`;
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: `${SYSTEM_PROMPT}\nReturn a JSON object {"transactions": [...]} .` },
            { type: 'file', file: { filename: 'ptr.pdf', file_data: dataUrl } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`openai ${res.status} ${await safeText(res)}`);
  const payload = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = payload.choices?.[0]?.message?.content;
  if (!text) throw new Error('openai: empty completion');
  return parseModelJson(text).map(toParsedTx);
}

/** Anthropic messages call (base64 `document` block BEFORE the text block). */
async function runAnthropic(model: string, key: string, bytes: ArrayBuffer): Promise<ParsedTx[]> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 8000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: arrayBufferToBase64(bytes) },
            },
            { type: 'text', text: `${SYSTEM_PROMPT}\nReturn ONLY the JSON array.` },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status} ${await safeText(res)}`);
  const payload = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = (payload.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim();
  if (!text) throw new Error('anthropic: no text block');
  return parseModelJson(text).map(toParsedTx);
}

/** Run one candidate over one document's bytes, timing it and trapping errors. */
export async function runCandidateOnDoc(
  env: Env,
  candidate: BakeoffCandidate,
  docId: string,
  bytes: ArrayBuffer,
): Promise<CandidateDocResult> {
  const { provider, model } = candidate;
  const base = { provider, model, docId };
  const key = keyFor(env, provider);
  if (!key) {
    return { ...base, ok: false, error: `${provider} API key not configured`, latencyMs: 0, rowCount: 0, rowKeys: [] };
  }

  const started = Date.now();
  try {
    let rows: ParsedTx[];
    if (provider === 'gemini') {
      const result = await new VisionLlmExtractor(env, { model, apiKey: key }).extract({
        filing: { docKind: 'scanned_pdf' } as never,
        bytes,
      });
      rows = result.transactions;
    } else if (provider === 'openai') {
      rows = await runOpenAi(model, key, bytes);
    } else {
      rows = await runAnthropic(model, key, bytes);
    }
    return {
      ...base,
      ok: true,
      latencyMs: Date.now() - started,
      rowCount: rows.length,
      rowKeys: rows.map(arbitrationRowKey),
    };
  } catch (err) {
    return {
      ...base,
      ok: false,
      error: (err as Error).message.slice(0, 300),
      latencyMs: Date.now() - started,
      rowCount: 0,
      rowKeys: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Pure aggregation (unit-tested) — no I/O.
// ---------------------------------------------------------------------------

/**
 * For each document, the "consensus" row set = row keys found by a strict
 * MAJORITY of the models that successfully ran that doc. Each model's agreement
 * is the mean fraction of that consensus it recovered — a recall-vs-peers proxy
 * that needs no hand-labelled answer key.
 */
export function computeConsensusAgreement(results: CandidateDocResult[]): Map<string, number> {
  const byDoc = new Map<string, CandidateDocResult[]>();
  for (const r of results) {
    if (!byDoc.has(r.docId)) byDoc.set(r.docId, []);
    byDoc.get(r.docId)!.push(r);
  }

  // Per model: accumulate recovered-fraction across docs that had a consensus.
  const sum = new Map<string, number>();
  const count = new Map<string, number>();

  for (const docResults of byDoc.values()) {
    const ok = docResults.filter((r) => r.ok);
    if (ok.length < 2) continue; // need ≥2 models to form a consensus

    // Tally how many models found each key; consensus = found by > half.
    const keyVotes = new Map<string, number>();
    for (const r of ok) {
      for (const k of new Set(r.rowKeys)) keyVotes.set(k, (keyVotes.get(k) ?? 0) + 1);
    }
    const majority = Math.floor(ok.length / 2) + 1;
    const consensus = new Set([...keyVotes].filter(([, v]) => v >= majority).map(([k]) => k));
    if (consensus.size === 0) continue;

    for (const r of ok) {
      const have = new Set(r.rowKeys);
      let hit = 0;
      for (const k of consensus) if (have.has(k)) hit++;
      const m = label(r);
      sum.set(m, (sum.get(m) ?? 0) + hit / consensus.size);
      count.set(m, (count.get(m) ?? 0) + 1);
    }
  }

  const out = new Map<string, number>();
  for (const [m, s] of sum) out.set(m, s / (count.get(m) || 1));
  return out;
}

/** Roll per-doc results up into one summary row per model. */
export function summarizeModels(
  candidates: BakeoffCandidate[],
  results: CandidateDocResult[],
): ModelSummary[] {
  const agreement = computeConsensusAgreement(results);
  return candidates.map((c) => {
    const mine = results.filter((r) => r.provider === c.provider && r.model === c.model);
    const ok = mine.filter((r) => r.ok);
    const totalRows = ok.reduce((s, r) => s + r.rowCount, 0);
    const latencySum = mine.reduce((s, r) => s + r.latencyMs, 0);
    return {
      provider: c.provider,
      model: c.model,
      label: label(c),
      docsAttempted: mine.length,
      docsOk: ok.length,
      failures: mine.length - ok.length,
      totalRows,
      avgRowsPerOkDoc: ok.length ? round2(totalRows / ok.length) : 0,
      avgLatencyMs: mine.length ? Math.round(latencySum / mine.length) : 0,
      consensusAgreement: round2(agreement.get(label(c)) ?? 0),
    };
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
