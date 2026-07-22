/**
 * src/extraction/anthropicVision.ts
 * OWNER: extraction agent
 *
 * Anthropic Vision extractor for scanned-image PDFs (docKind 'scanned_pdf').
 */

import type { Extractor, ExtractorInput, ExtractorResult } from '../extractors/types.ts';
import type { Env, Filing, ParsedTx } from '../shared/types.ts';
import { resolveSecret } from '../secrets/infisical.ts';
import {
  SYSTEM_PROMPT,
  EXECUTIVE_SYSTEM_PROMPT,
  parseTruncationAwareJson,
  markSalvaged,
  validatePdfForAnthropic,
  resavePdfForAnthropic,
  isAnthropicInvalidPdfError,
  toParsedTx,
  fetchWithRetry,
  arrayBufferToBase64,
} from './visionLlm.ts';
import { recordLlmSpend } from '../shared/llmSpend.ts';
import { candidateSpendUsd } from './bakeoff.ts';

const DEFAULT_MODEL = 'claude-sonnet-5';
const DEFAULT_CONFIDENCE = 0.6;
/** First-call token budget. Kept modest to protect cost on the common case. */
const MAX_TOKENS = 8000;
/** Retry budget when the first call was cut off (`stop_reason: 'max_tokens'`). */
const MAX_TOKENS_RETRY = 16000;

interface AnthropicMessagesPayload {
  content?: Array<{ type: string; text?: string }>;
  /** 'max_tokens' means the response was cut off before completion. */
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface AnthropicVisionOptions {
  apiKey?: string;
  apiKeyName?: keyof Env & string;
  model?: string;
  modelEnvName?: keyof Env & string;
  defaultModel?: string;
  name?: string;
}

export class AnthropicVisionExtractor implements Extractor {
  readonly name: string;
  private readonly modelOverride?: string;
  private readonly modelEnvName: keyof Env & string;
  private readonly defaultModel: string;
  private readonly apiKeyOverride?: string;
  private readonly apiKeyName: keyof Env & string;

  constructor(
    private readonly env: Env,
    options: AnthropicVisionOptions = {},
  ) {
    this.name = options.name ?? 'anthropicVision';
    this.modelOverride = options.model;
    this.modelEnvName = options.modelEnvName ?? 'ANTHROPIC_MODEL';
    this.defaultModel = options.defaultModel ?? DEFAULT_MODEL;
    this.apiKeyOverride = options.apiKey;
    this.apiKeyName = options.apiKeyName ?? 'ANTHROPIC_API_KEY';
  }

  canHandle(f: Filing): boolean {
    return f.docKind === 'scanned_pdf';
  }

  private async resolveModel(): Promise<string> {
    if (this.modelOverride) return this.modelOverride;
    try {
      return (await resolveSecret(this.env, this.modelEnvName)).value || this.defaultModel;
    } catch {
      return (this.env[this.modelEnvName] as string | undefined) || this.defaultModel;
    }
  }

  async extract(input: ExtractorInput): Promise<ExtractorResult> {
    const key = this.apiKeyOverride ?? (await resolveSecret(this.env, this.apiKeyName)).value;
    if (!key) throw new Error(`${this.name}: API key is not configured`);
    if (!input.bytes) throw new Error(`${this.name}: no bytes provided on ExtractorInput`);

    const model = await this.resolveModel();
    const promptToUse = input.filing.chamber === 'executive' ? EXECUTIVE_SYSTEM_PROMPT : SYSTEM_PROMPT;

    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let combinedRaw = '';
    let allRows: ParsedTx[] = [];

    try {
      // Pre-validate the PDF via pdf-lib before any provider call — bytes are
      // unchanged on success. Anthropic's API 400s outright on some malformed
      // PDFs; an unparseable PDF fails fast here instead of spending a
      // request. See validatePdfForAnthropic's doc comment in visionLlm.ts
      // for why the ORIGINAL bytes (not a pdf-lib resave) are the primary
      // path sent below.
      await validatePdfForAnthropic(input.bytes);

      const callAnthropic = async (documentBase64: string, maxTokens: number): Promise<AnthropicMessagesPayload> => {
        const res = await fetchWithRetry(
          'https://api.anthropic.com/v1/messages',
          {
            method: 'POST',
            headers: {
              'x-api-key': key,
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json',
              'anthropic-beta': 'pdfs-2024-09-25'
            },
            body: JSON.stringify({
              model,
              max_tokens: maxTokens,
              thinking: { type: 'disabled' },
              messages: [
                {
                  role: 'user',
                  content: [
                    {
                      type: 'document',
                      source: {
                        type: 'base64',
                        media_type: 'application/pdf',
                        data: documentBase64,
                      },
                    },
                    { type: 'text', text: `${promptToUse}\nReturn ONLY the JSON array.` },
                  ],
                },
              ],
            }),
            signal: input.signal
              ? AbortSignal.any([input.signal, AbortSignal.timeout(600_000)])
              : AbortSignal.timeout(600_000),
          },
          this.name,
          { model, spendGuard: { env: this.env, provider: 'anthropic' } }
        );

        if (!res.ok) {
          let detail = '';
          try {
            detail = (await res.text()).slice(0, 500);
          } catch {
            /* ignore */
          }
          throw new Error(`${this.name}: Anthropic API ${res.status} ${res.statusText} ${detail}`);
        }

        return (await res.json()) as AnthropicMessagesPayload;
      };

      // One full call (+ truncation retry) attempt against a given byte
      // source. First call uses a modest token budget to protect cost; if
      // the model was cut off mid-output, retry once with a doubled budget.
      const attempt = async (
        pdfBytes: ArrayBuffer,
      ): Promise<{ payload: AnthropicMessagesPayload; promptTokens: number; completionTokens: number }> => {
        const documentBase64 = arrayBufferToBase64(pdfBytes);
        let payload = await callAnthropic(documentBase64, MAX_TOKENS);
        let promptTokens = payload.usage?.input_tokens ?? 0;
        let completionTokens = payload.usage?.output_tokens ?? 0;

        if (payload.stop_reason === 'max_tokens') {
          const retryPayload = await callAnthropic(documentBase64, MAX_TOKENS_RETRY);
          promptTokens += retryPayload.usage?.input_tokens ?? 0;
          completionTokens += retryPayload.usage?.output_tokens ?? 0;
          payload = retryPayload;
        }
        return { payload, promptTokens, completionTokens };
      };

      let payload: AnthropicMessagesPayload;
      try {
        const result = await attempt(input.bytes);
        payload = result.payload;
        totalPromptTokens = result.promptTokens;
        totalCompletionTokens = result.completionTokens;
      } catch (err) {
        // Repair retry: Anthropic's parser sometimes rejects previously-good
        // PDF bytes outright (receipted 2026-07-15 doc H-2026-20034954
        // production regression). One shot only — resave via pdf-lib and
        // retry ONCE; if the retry also fails (for this reason or any
        // other), surface the ORIGINAL error, not the retry's.
        if (!isAnthropicInvalidPdfError((err as Error).message)) throw err;
        try {
          const resavedBytes = await resavePdfForAnthropic(input.bytes);
          const result = await attempt(resavedBytes);
          payload = result.payload;
          totalPromptTokens = result.promptTokens;
          totalCompletionTokens = result.completionTokens;
        } catch {
          throw err;
        }
      }

      const text = (payload.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
        .trim();

      if (!text) {
        throw new Error(`${this.name}: Anthropic returned no text block`);
      }

      combinedRaw = text;

      // If the (possibly retried) call is still truncated, salvage the
      // complete leading rows instead of failing the whole read.
      let parsedRows;
      let salvaged: boolean;
      try {
        const parsed = parseTruncationAwareJson(text, payload.stop_reason === 'max_tokens');
        parsedRows = parsed.rows;
        salvaged = parsed.salvaged;
      } catch (err) {
        throw new Error(`${this.name}: could not parse model JSON: ${(err as Error).message}`);
      }

      allRows = parsedRows.map(toParsedTx).map((tx: ParsedTx) => (salvaged ? markSalvaged(tx) : tx));
    } catch (err) {
      const usage =
        totalPromptTokens > 0 || totalCompletionTokens > 0
          ? { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens }
          : undefined;
      if (usage) {
        await recordLlmSpend(this.env, 'anthropic', candidateSpendUsd('anthropic', model, model, usage) ?? 0);
      }
      throw Object.assign(err as Error, { usage });
    }

    const docConfidence =
      allRows.length > 0
        ? allRows.reduce((s, r) => s + r.confidence, 0) / allRows.length
        : DEFAULT_CONFIDENCE;

    const usage =
      totalPromptTokens > 0 || totalCompletionTokens > 0
        ? { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens }
        : undefined;

    if (usage) {
      await recordLlmSpend(this.env, 'anthropic', candidateSpendUsd('anthropic', model, model, usage) ?? 0);
    }

    return {
      transactions: allRows,
      confidence: docConfidence,
      raw: combinedRaw,
      extractor: this.name,
      modelVersion: model,
      usage,
    };
  }
}
