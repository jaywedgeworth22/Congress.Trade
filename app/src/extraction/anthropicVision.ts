/**
 * src/extraction/anthropicVision.ts
 * OWNER: extraction agent
 *
 * Anthropic Vision extractor for scanned-image PDFs (docKind 'scanned_pdf').
 */

import type { Extractor, ExtractorInput, ExtractorResult } from '../extractors/types';
import type { Env, Filing, ParsedTx } from '../shared/types';
import { resolveSecret } from '../secrets/infisical';
import {
  SYSTEM_PROMPT,
  EXECUTIVE_SYSTEM_PROMPT,
  parseModelJson,
  toParsedTx,
  fetchWithRetry,
  arrayBufferToBase64,
} from './visionLlm';

const DEFAULT_MODEL = 'claude-3-5-sonnet-20241022';
const DEFAULT_CONFIDENCE = 0.6;

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
            max_tokens: 8000,
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'document',
                    source: {
                      type: 'base64',
                      media_type: 'application/pdf',
                      data: arrayBufferToBase64(input.bytes),
                    },
                  },
                  { type: 'text', text: `${promptToUse}\nReturn ONLY the JSON array.` },
                ],
              },
            ],
          }),
          signal: AbortSignal.timeout(120_000),
        },
        this.name,
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

      const payload = (await res.json()) as any;

      if (payload.usage) {
        totalPromptTokens = payload.usage.input_tokens ?? 0;
        totalCompletionTokens = payload.usage.output_tokens ?? 0;
      }

      const text = (payload.content ?? [])
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text ?? '')
        .join('')
        .trim();

      if (!text) {
        throw new Error(`${this.name}: Anthropic returned no text block`);
      }

      combinedRaw = text;

      let parsed;
      try {
        parsed = parseModelJson(text);
      } catch (err) {
        throw new Error(`${this.name}: could not parse model JSON: ${(err as Error).message}`);
      }

      allRows = parsed.map(toParsedTx);
    } catch (err) {
      const usage =
        totalPromptTokens > 0 || totalCompletionTokens > 0
          ? { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens }
          : undefined;
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
