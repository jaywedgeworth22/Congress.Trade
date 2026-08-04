/**
 * Senate paper PTR media recovery.
 *
 * Electronic PTRs are HTML tables. Paper PTRs (`/search/view/paper/<uuid>/`) are
 * an HTML viewer shell whose real content is multi-page scans hosted on
 * efd-media-public.senate.gov as <img class="filingImage"> GIFs. Storing only
 * the shell and running senateHtml yields zero rows even though the trades are
 * public page images.
 *
 * This module extracts those public media URLs and OCRs them via OpenRouter
 * vision (image_url — CDN is public, no R2 rewrite required).
 */

import type { Env, Owner, ParsedTx, TxType } from '../shared/types.ts';
import { resolveSecret } from '../secrets/infisical.ts';
import { openrouterRequestEnrichment } from '@jaywedgeworth22/congress-trading-shared';
import { environmentName } from '../shared/thirdPartyTelemetry.ts';
import { parseAmountRange } from './amounts.ts';
import { parseTruncationAwareJson, fetchWithRetry } from './visionLlm.ts';

const EFD_MEDIA_HOST = 'efd-media-public.senate.gov';
const DEFAULT_MODEL = 'x-ai/grok-4.5';
const PAPER_CONFIDENCE = 0.85;

const PAPER_OCR_PROMPT = `This is page image(s) of a Senate paper PERIODIC DISCLOSURE OF FINANCIAL TRANSACTIONS form.
Amount columns are checkbox bands left-to-right:
$1,001 - $15,000 | $15,001 - $50,000 | $50,001 - $100,000 | $100,001 - $250,000 | $250,001 - $500,000 | $500,001 - $1,000,000 | Over $1,000,000 | ...
Only emit a transaction when Purchase/Sale/Exchange has an X AND one amount band has an X.
txType: P=Purchase, S=Sale, E=Exchange.
owner: self if no prefix, spouse if (S), joint if (J), dependent if (DC).
Include parent fund/header as subholding when the row is nested under a fund name.
Skip blank rows, cover letters, and header-only fund labels without a date.
Return ONLY JSON: {"transactions":[{"txDate":"YYYY-MM-DD","owner":"self|spouse|joint|dependent|unknown","ticker":null,"assetName":"string","subholding":null,"txType":"P|S|E","amountRange":"$A - $B","rawText":"short quote"}]}`;

/** True when HTML looks like the eFD paper filing viewer (carousel of page scans). */
export function isSenatePaperViewerHtml(html: string): boolean {
  const h = html.toLowerCase();
  return (
    h.includes('filingimage')
    || h.includes('/search/view/paper/')
    || h.includes('/search/print/paper/')
    || (h.includes('efd-media-public.senate.gov') && h.includes('page 1 of'))
  );
}

/**
 * Collect absolute page-scan URLs from a paper viewer HTML shell.
 * Prefer img.filingImage; fall back to any efd-media-public media URL.
 */
export function extractSenatePaperMediaUrls(html: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();

  const filingImg = /class=["'][^"']*filingImage[^"']*["'][^>]*src=["']([^"']+)["']/gi;
  const filingImg2 = /src=["']([^"']+)["'][^>]*class=["'][^"']*filingImage[^"']*["']/gi;
  for (const re of [filingImg, filingImg2]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      pushUrl(urls, seen, m[1]);
    }
  }

  if (urls.length === 0) {
    const anyMedia = /https?:\/\/efd-media-public\.senate\.gov\/media\/[^"'>\s]+/gi;
    let m: RegExpExecArray | null;
    while ((m = anyMedia.exec(html)) !== null) {
      pushUrl(urls, seen, m[0]);
    }
  }

  return urls;
}

function pushUrl(out: string[], seen: Set<string>, raw: string): void {
  let u = raw.trim();
  if (!u) return;
  if (u.startsWith('//')) u = `https:${u}`;
  if (u.startsWith('/')) return; // relative static assets only
  try {
    const parsed = new URL(u);
    if (parsed.hostname.toLowerCase() !== EFD_MEDIA_HOST) return;
    if (!parsed.pathname.includes('/media/')) return;
  } catch {
    return;
  }
  if (seen.has(u)) return;
  seen.add(u);
  out.push(u);
}

export interface PaperMediaExtractResult {
  transactions: ParsedTx[];
  confidence: number;
  modelVersion: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    costUsd?: number;
  };
  mediaCount: number;
}

/**
 * OCR public paper page scans via OpenRouter vision (image_url to the CDN).
 */
export async function extractFromSenatePaperMedia(
  env: Env,
  mediaUrls: string[],
  opts: { signal?: AbortSignal; model?: string; docId?: string } = {},
): Promise<PaperMediaExtractResult> {
  if (mediaUrls.length === 0) {
    return { transactions: [], confidence: 0.2, modelVersion: '', mediaCount: 0 };
  }

  const keyRes = await resolveSecret(env, 'OPENROUTER_API_KEY');
  const apiKey = keyRes.value?.trim();
  if (!apiKey) {
    throw new Error('senatePaperMedia: OPENROUTER_API_KEY not configured');
  }

  // Prefer explicit opt, else Grok 4.5 via OpenRouter (matches live senate primary).
  const model = opts.model ?? DEFAULT_MODEL;

  const content: Array<Record<string, unknown>> = [
    { type: 'text', text: PAPER_OCR_PROMPT },
  ];
  for (const url of mediaUrls.slice(0, 12)) {
    content.push({ type: 'image_url', image_url: { url } });
  }

  const classifierEnrichment = openrouterRequestEnrichment({
    sourceApp: 'congress-trade',
    environment: environmentName(env),
    service: 'senate-paper-media',
    feature: 'senate-paper-media-ocr',
    keyRef: 'OPENROUTER_API_KEY',
    user: opts.docId || undefined,
  });

  const body = {
    model,
    messages: [{ role: 'user', content }],
    temperature: 0,
    max_tokens: 8000,
    usage: { include: true },
    ...classifierEnrichment,
  };

  const res = await fetchWithRetry(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://congress.trade',
        'X-Title': 'Congress.Trade senate paper media',
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    },
    'senate-paper-media-ocr',
    { model, spendGuard: { env, provider: 'openrouter' } },
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`senatePaperMedia: OpenRouter HTTP ${res.status} ${errText.slice(0, 240)}`);
  }

  const payload = await res.json() as {
    model?: string;
    choices?: Array<{ message?: { content?: string } }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      cost?: number;
    };
  };

  const text = payload.choices?.[0]?.message?.content ?? '';
  const parsed = parseTruncationAwareJson(text) as {
    transactions?: Array<Record<string, unknown>>;
  } | null;
  const rawRows = Array.isArray(parsed?.transactions) ? parsed!.transactions! : [];
  const transactions = rawRows.map(mapPaperRow).filter((t): t is ParsedTx => t !== null);

  return {
    transactions,
    confidence: transactions.length > 0 ? PAPER_CONFIDENCE : 0.25,
    modelVersion: `openrouter:${payload.model ?? model}`,
    usage: {
      promptTokens: payload.usage?.prompt_tokens,
      completionTokens: payload.usage?.completion_tokens,
      costUsd: typeof payload.usage?.cost === 'number' ? payload.usage.cost : undefined,
    },
    mediaCount: mediaUrls.length,
  };
}

function mapPaperRow(row: Record<string, unknown>): ParsedTx | null {
  const assetName = typeof row.assetName === 'string' ? row.assetName.trim() : '';
  if (!assetName) return null;
  const txDateRaw = typeof row.txDate === 'string' ? row.txDate.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(txDateRaw)) return null;

  const txType = normalizeTxType(row.txType);
  if (!txType) return null;

  const amountRange = typeof row.amountRange === 'string' ? row.amountRange : '';
  const { min, max } = parseAmountRange(amountRange);

  const owner = normalizeOwner(row.owner);
  const subholding = typeof row.subholding === 'string' && row.subholding.trim()
    ? row.subholding.trim()
    : null;
  const ticker = typeof row.ticker === 'string' && row.ticker.trim()
    ? row.ticker.trim().toUpperCase()
    : null;
  const rawText = typeof row.rawText === 'string' ? row.rawText : `${assetName} ${txDateRaw} ${txType}`;

  return {
    txDate: txDateRaw,
    owner,
    assetName,
    ticker,
    assetType: 'other',
    txType,
    amountMin: min,
    amountMax: max,
    isOption: false,
    capGainsOver200: false,
    rawText,
    subholding,
    confidence: PAPER_CONFIDENCE,
  };
}

function normalizeTxType(raw: unknown): TxType | null {
  const s = String(raw ?? '').trim().toUpperCase();
  if (s === 'P' || s.startsWith('PURCH')) return 'P';
  if (s === 'S' || s.startsWith('SALE') || s.startsWith('SELL')) return 'S';
  if (s === 'E' || s.startsWith('EXCH')) return 'E';
  return null;
}

function normalizeOwner(raw: unknown): Owner {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === 'spouse' || s === 's' || s === '(s)') return 'spouse';
  if (s === 'joint' || s === 'j' || s === '(j)') return 'joint';
  if (s === 'dependent' || s === 'dc' || s === '(dc)') return 'dependent';
  // Owner is a closed enum (self|spouse|joint|dependent). Unspecified/blank PTR
  // rows match vision extraction: default to self rather than inventing "unknown".
  return 'self';
}
