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
import { parseAmountRange } from './amounts.ts';
import { parseTruncationAwareJson, fetchWithRetry, arrayBufferToBase64 } from './visionLlm.ts';
import { createProxiedFetch, resolveResidentialProxyUrl } from '../shared/proxyFetch.ts';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';
import { senateRelayAuthHeaders } from '../ingestion/senateRelayHealth.ts';
import {
  OPENROUTER_PURPOSE,
  buildOpenRouterClassifier,
  openRouterAttributionHeaders,
} from '../shared/openRouterAttribution.ts';

const EFD_MEDIA_HOST = 'efd-media-public.senate.gov';
const DEFAULT_MODEL = 'google/gemini-2.5-flash';
const PAPER_CONFIDENCE = 0.85;

const PAPER_OCR_PROMPT = `This is page image(s) of a Senate paper PERIODIC DISCLOSURE OF FINANCIAL TRANSACTIONS form.
Amount columns are checkbox bands left-to-right:
$1,001 - $15,000 | $15,001 - $50,000 | $50,001 - $100,000 | $100,001 - $250,000 | $250,001 - $500,000 | $500,001 - $1,000,000 | Over $1,000,000 | ...
Only emit a transaction when Purchase/Sale/Exchange (Buy/Sell/Exchange) has an X AND one amount band has an X.
txType: B=Buy (Purchase/P), S=Sell (Sale), E=Exchange. Always emit B for buys.
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

async function loadMediaAsDataUrl(
  env: Env,
  url: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const proxyUrl = await resolveResidentialProxyUrl(env);
  const effectiveFetch = proxyUrl ? createProxiedFetch(proxyUrl, fetch) : fetch;
  const senateRelayUrl = env.SENATE_RELAY_URL ? env.SENATE_RELAY_URL.replace(/\/$/, '') : undefined;

  // 1. Try residential proxy if configured
  if (proxyUrl) {
    try {
      const res = await trackedFetch(
        url,
        {
          signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://efdsearch.senate.gov/',
          },
        },
        {
          service: 'senatePaperMedia',
          operation: 'fetch_paper_image_proxy',
        },
        effectiveFetch,
        { envOverride: env },
      );
      if (res.ok) {
        const contentType = res.headers.get('content-type') || (url.endsWith('.png') ? 'image/png' : url.endsWith('.gif') ? 'image/gif' : 'image/jpeg');
        const buf = await res.arrayBuffer();
        if (buf.byteLength > 0) {
          return `data:${contentType.split(';')[0].trim()};base64,${arrayBufferToBase64(buf)}`;
        }
      }
    } catch {}
  }

  // 2. Try Senate relay /fetch-doc if configured
  if (senateRelayUrl) {
    try {
      const res = await trackedFetch(
        `${senateRelayUrl}/fetch-doc`,
        {
          method: 'POST',
          signal,
          headers: {
            'content-type': 'application/json',
            accept: '*/*',
            ...senateRelayAuthHeaders(env.SENATE_RELAY_SECRET),
          },
          body: JSON.stringify({ url }),
        },
        {
          service: 'senatePaperMedia',
          operation: 'fetch_paper_image_relay',
        },
        fetch,
        { envOverride: env },
      );
      if (res.ok) {
        const contentType = res.headers.get('content-type') || (url.endsWith('.png') ? 'image/png' : url.endsWith('.gif') ? 'image/gif' : 'image/jpeg');
        const buf = await res.arrayBuffer();
        if (buf.byteLength > 0) {
          return `data:${contentType.split(';')[0].trim()};base64,${arrayBufferToBase64(buf)}`;
        }
      }
    } catch {}
  }

  // 3. Fallback direct fetch with browser headers & Referer
  try {
    const res = await trackedFetch(
      url,
      {
        signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://efdsearch.senate.gov/',
        },
      },
      {
        service: 'senatePaperMedia',
        operation: 'fetch_paper_image_direct',
      },
      fetch,
      { envOverride: env },
    );
    if (res.ok) {
      const contentType = res.headers.get('content-type') || (url.endsWith('.png') ? 'image/png' : url.endsWith('.gif') ? 'image/gif' : 'image/jpeg');
      const buf = await res.arrayBuffer();
      if (buf.byteLength > 0) {
        return `data:${contentType.split(';')[0].trim()};base64,${arrayBufferToBase64(buf)}`;
      }
    }
  } catch {}

  return null;
}

/**
 * OCR public paper page scans via OpenRouter vision (inline base64 data URLs).
 */
export async function extractFromSenatePaperMedia(
  env: Env,
  mediaUrls: string[],
  opts: { signal?: AbortSignal; model?: string } = {},
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

  const resolvedUrls = await Promise.all(
    mediaUrls.slice(0, 12).map((url) => loadMediaAsDataUrl(env, url, opts.signal)),
  );

  const validDataUrls = resolvedUrls.filter((u): u is string => typeof u === 'string' && u.startsWith('data:'));
  if (validDataUrls.length === 0) {
    throw new Error('senatePaperMedia: unable to load page scan images from Senate eFD (relay/proxy unreachable)');
  }

  const content: Array<Record<string, unknown>> = [
    { type: 'text', text: PAPER_OCR_PROMPT },
  ];
  for (const url of validDataUrls) {
    content.push({ type: 'image_url', image_url: { url } });
  }

  const classifierEnrichment = buildOpenRouterClassifier(env, {
    service: 'senatePaperMedia',
    purpose: OPENROUTER_PURPOSE.SENATE_PAPER_OCR,
    feature: 'senate-paper-ocr',
    chamber: 'senate',
    keyRef: 'OPENROUTER_API_KEY',
  });
  const body = {
    model,
    messages: [{ role: 'user', content }],
    temperature: 0,
    max_tokens: 8000,
    usage: { include: true },
    // Keep all CT OpenRouter traffic under one app title for Activity /
    // Apps analytics; differentiate call sites via trace.feature instead.
    ...classifierEnrichment,
  };

  const res = await fetchWithRetry(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...openRouterAttributionHeaders(),
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
  const parsed = parseTruncationAwareJson(text);
  const rawRows = Array.isArray(parsed?.rows) ? parsed.rows : [];
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

function normalizeTxDate(raw: unknown): string | null {
  const t = String(raw ?? '').trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const [, mm, dd, yy] = m;
    const year = yy.length === 2 ? `20${yy}` : yy;
    return `${year}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  const iso = new Date(t);
  if (!isNaN(iso.getTime()) && t.length >= 8) {
    return iso.toISOString().slice(0, 10);
  }
  return null;
}

function mapPaperRow(row: Record<string, unknown>): ParsedTx | null {
  const assetName = typeof row.assetName === 'string'
    ? row.assetName.trim()
    : typeof row.asset_name === 'string'
    ? row.asset_name.trim()
    : typeof row.identification_of_assets === 'string'
    ? row.identification_of_assets.trim()
    : '';
  if (!assetName) return null;

  const rawDate = row.txDate ?? row.transaction_date ?? row.date ?? row.tx_date;
  const txDate = normalizeTxDate(rawDate);
  if (!txDate) return null;

  const rawTxType = row.txType ?? row.transaction_type ?? row.type ?? row.tx_type;
  const txType = normalizeTxType(rawTxType);
  if (!txType) return null;

  const amountRange = typeof row.amountRange === 'string'
    ? row.amountRange
    : typeof row.amount_of_transaction === 'string'
    ? row.amount_of_transaction
    : typeof row.amount === 'string'
    ? row.amount
    : '';
  const { min, max } = parseAmountRange(amountRange);

  const owner = normalizeOwner(row.owner);
  const subholding = typeof row.subholding === 'string' && row.subholding.trim()
    ? row.subholding.trim()
    : null;
  const ticker = typeof row.ticker === 'string' && row.ticker.trim()
    ? row.ticker.trim().toUpperCase()
    : null;
  const rawText = typeof row.rawText === 'string' ? row.rawText : `${assetName} ${txDate} ${txType}`;

  return {
    txDate,
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
  // Storage P|S|E; product buy letter B aliases P.
  if (s === 'P' || s === 'B' || s.startsWith('PURCH') || s === 'BUY') return 'B';
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
