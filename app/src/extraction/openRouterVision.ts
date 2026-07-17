/**
 * src/extraction/openRouterVision.ts
 * OWNER: extraction agent
 *
 * OpenRouter / OpenAI-compatible Vision extractor for scanned-image PDFs.
 */

import type { Extractor, ExtractorInput, ExtractorResult } from '../extractors/types';
import type { Env, Filing, ParsedTx } from '../shared/types';
import { getDocumentProxy } from 'unpdf';
import { resolveSecret } from '../secrets/infisical';
import {
  SYSTEM_PROMPT,
  EXECUTIVE_SYSTEM_PROMPT,
  parseModelJson,
  toParsedTx,
  fetchWithRetry,
  arrayBufferToBase64,
} from './visionLlm';

const DEFAULT_MODEL = 'qwen/qwen-2.5-vl-72b-instruct:free';
const DEFAULT_CONFIDENCE = 0.6;
const MAX_TOKENS = 8000;

interface OpenAIChatPayload {
  choices?: Array<{
    message?: {
      content?: string;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface OpenRouterVisionOptions {
  apiKey?: string;
  apiKeyName?: keyof Env & string;
  model?: string;
  modelEnvName?: keyof Env & string;
  defaultModel?: string;
  name?: string;
}


/** Returns true for models that accept a PDF as a `type: 'file'` attachment natively. */
function supportsNativeVision(model: string): boolean {
  const m = model.toLowerCase();
  if (m.includes('gpt-4o')) return true;
  if (m.includes('gpt-5')) return true;
  if (m.includes('claude-3') || m.includes('claude-4') || m.includes('claude-5')) return true;
  if (m.includes('gemini-1.5') || m.includes('gemini-2') || m.includes('gemini-3')) return true;
  return false;
}

export class OpenRouterVisionExtractor implements Extractor {
  readonly name: string;
  private readonly modelOverride?: string;
  private readonly modelEnvName: keyof Env & string;
  private readonly defaultModel: string;
  private readonly apiKeyOverride?: string;
  private readonly apiKeyName: keyof Env & string;

  constructor(
    private readonly env: Env,
    options: OpenRouterVisionOptions = {},
  ) {
    this.name = options.name ?? 'openRouterVision';
    this.modelOverride = options.model;
    this.modelEnvName = options.modelEnvName ?? 'OPENROUTER_MODEL';
    this.defaultModel = options.defaultModel ?? DEFAULT_MODEL;
    this.apiKeyOverride = options.apiKey;
    this.apiKeyName = options.apiKeyName ?? 'OPENROUTER_API_KEY';
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

    let pagesProcessed: number | undefined = undefined;
    if (model.toLowerCase().includes('mistral-ocr')) {
      try {
        const pdf = await getDocumentProxy(new Uint8Array(input.bytes.slice(0)));
        pagesProcessed = typeof pdf.numPages === 'number' && Number.isFinite(pdf.numPages) ? pdf.numPages : undefined;
      } catch {
        // ignore
      }
    }

    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let combinedRaw = '';
    let allRows: ParsedTx[] = [];

    try {
      // Use OpenRouter's native file type for universal PDF processing (via native support or internal OCR plugins).
      // We can pass the URL directly instead of a massive Base64 string if the URL is available.
      let fileData: string;
      if (input.filing.sourceUrl) {
        fileData = input.filing.sourceUrl;
      } else {
        fileData = `data:application/pdf;base64,${arrayBufferToBase64(input.bytes)}`;
      }

      const callOpenRouter = async (): Promise<OpenAIChatPayload> => {
        // Mistral OCR via OpenRouter requires image_url with the document URL
        // (or base64 data URI) — NOT the file-parser plugin approach.
        const isMistralOcr = model.includes('mistral-ocr');
        let messageContent: unknown[];
        if (isMistralOcr) {
          // Per OpenRouter docs: Mistral OCR accepts `image_url` pointing to the PDF.
          messageContent = [
            {
              type: 'text',
              text: `${promptToUse}\nReturn ONLY the JSON array.`,
            },
            {
              type: 'image_url',
              image_url: { url: fileData },
            },
          ];
        } else {
          messageContent = [
            {
              type: 'file',
              file: {
                filename: 'document.pdf',
                file_data: fileData,
              },
            },
            { type: 'text', text: `${promptToUse}\nReturn ONLY the JSON array.` },
          ];
        }

        const plugins = isMistralOcr
          ? [{ id: 'response-healing' }]
          : [
              { id: 'response-healing' },
              ...(supportsNativeVision(model)
                ? []
                : [{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }]),
            ];

        const res = await fetchWithRetry(
          'https://openrouter.ai/api/v1/chat/completions',
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${key}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://congress.trade',
              'X-Title': 'Congress.Trade',
            },
            body: JSON.stringify({
              model,
              max_tokens: MAX_TOKENS,
              response_format: { type: 'json_object' },
              plugins,
              messages: [
                {
                  role: 'user',
                  content: messageContent,
                },
              ],
            }),
            signal: AbortSignal.timeout(120_000),
          },
          this.name,
          { model }
        );

        if (!res.ok) {
          let detail = '';
          try {
            detail = (await res.text()).slice(0, 500);
          } catch {
            /* ignore */
          }
          throw new Error(`${this.name}: OpenRouter API ${res.status} ${res.statusText} ${detail}`);
        }

        return (await res.json()) as OpenAIChatPayload;
      };

      const payload = await callOpenRouter();
      
      totalPromptTokens = payload.usage?.prompt_tokens ?? 0;
      totalCompletionTokens = payload.usage?.completion_tokens ?? 0;

      const text = payload.choices?.[0]?.message?.content ?? '';

      if (!text) {
        throw new Error(`${this.name}: OpenRouter returned no text block`);
      }

      combinedRaw = text;

      let parsedRows;
      try {
        parsedRows = parseModelJson(text);
      } catch (err) {
        throw new Error(`${this.name}: could not parse model JSON: ${(err as Error).message}`);
      }

      allRows = parsedRows.map(toParsedTx);
    } catch (err) {
      const usage =
        totalPromptTokens > 0 || totalCompletionTokens > 0 || pagesProcessed != null
          ? {
              promptTokens: totalPromptTokens,
              completionTokens: totalCompletionTokens,
              ...(pagesProcessed != null ? { pagesProcessed } : {}),
            }
          : undefined;
      throw Object.assign(err as Error, { usage });
    }

    const docConfidence =
      allRows.length > 0
        ? allRows.reduce((s, r) => s + r.confidence, 0) / allRows.length
        : DEFAULT_CONFIDENCE;

    const usage =
      totalPromptTokens > 0 || totalCompletionTokens > 0 || pagesProcessed != null
        ? {
            promptTokens: totalPromptTokens,
            completionTokens: totalCompletionTokens,
            ...(pagesProcessed != null ? { pagesProcessed } : {}),
          }
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
