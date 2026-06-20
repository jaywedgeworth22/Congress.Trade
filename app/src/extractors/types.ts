/**
 * src/extractors/types.ts
 * Pluggable extractor framework. The framework contracts + the env-driven
 * arbitration WIRING are implemented here; the concrete extractors (senateHtml,
 * textPdf, visionLlm) are stubs in src/extraction/* that the extraction agent
 * fills against the Extractor interface below.
 */

import type { Env, Filing, ParsedTx } from '../shared/types';

// ---------------------------------------------------------------------------
// Core contracts
// ---------------------------------------------------------------------------

/** Result of running an extractor over one filing. */
export interface ExtractorResult {
  /** Parsed (pre-normalization) transactions. */
  transactions: ParsedTx[];
  /** Document-level confidence in [0,1]. */
  confidence: number;
  /** Raw extracted text/markup retained for audit + review. */
  raw: string;
  /** Name of the extractor that produced this result. */
  extractor: string;
  /** Model/version identifier when an LLM was used (optional). */
  modelVersion?: string;
}

/** Input handed to an extractor. One of bytes/html is typically present. */
export interface ExtractorInput {
  filing: Filing;
  /** Raw bytes (PDF) when applicable. */
  bytes?: ArrayBuffer;
  /** Raw HTML (Senate eFD) when applicable. */
  html?: string;
}

/**
 * A pluggable extraction strategy. Implementations live in src/extraction/*.
 * canHandle() lets buildExtractorPipeline() route a filing to the right one.
 */
export interface Extractor {
  /** Stable extractor name, recorded on filings.extractor. */
  name: string;
  /** True if this extractor can handle the given filing (by docKind etc.). */
  canHandle(f: Filing): boolean;
  /** Run extraction. Implementations resolve to an ExtractorResult. */
  extract(input: ExtractorInput): Promise<ExtractorResult>;
}

// ---------------------------------------------------------------------------
// Arbitration: run a primary extractor, optionally cross-check with a secondary
// ---------------------------------------------------------------------------

/**
 * ArbitratingExtractor wraps a primary Extractor and an optional secondary one.
 *
 * Behaviour (the env-driven WIRING is real; the compare/merge is a documented
 * stub returning the primary result for now):
 *   - ALWAYS runs the primary extractor.
 *   - If a secondary is present AND `env.ARBITRATION_API_KEY` is set AND the
 *     arbitration flag is enabled (env.ARBITRATION_ENABLED === 'true'), ALSO
 *     runs the secondary and arbitrates between the two results.
 *   - Otherwise returns the primary result unchanged.
 */
export class ArbitratingExtractor implements Extractor {
  readonly name: string;

  constructor(
    private readonly primary: Extractor,
    private readonly env: Env,
    private readonly secondary?: Extractor,
  ) {
    this.name = `arbitrating(${primary.name}${secondary ? `,${secondary.name}` : ''})`;
  }

  canHandle(f: Filing): boolean {
    return this.primary.canHandle(f);
  }

  /** True iff secondary arbitration should run for the current env config. */
  private arbitrationEnabled(): boolean {
    return (
      this.secondary !== undefined &&
      typeof this.env.ARBITRATION_API_KEY === 'string' &&
      this.env.ARBITRATION_API_KEY.length > 0 &&
      this.env.ARBITRATION_ENABLED === 'true'
    );
  }

  async extract(input: ExtractorInput): Promise<ExtractorResult> {
    // 1) Always run the primary extractor.
    const primaryResult = await this.primary.extract(input);

    // 2) Env-driven switch: only arbitrate when fully configured.
    if (!this.arbitrationEnabled() || !this.secondary) {
      return primaryResult;
    }

    // 3) Run the secondary and arbitrate.
    const secondaryResult = await this.secondary.extract(input);
    return this.arbitrate(primaryResult, secondaryResult);
  }

  /**
   * Compare/merge primary vs secondary results.
   *
   * TODO(extraction-agent): implement the real arbitration policy — e.g.
   * row-by-row reconciliation, confidence-weighted field selection, and
   * down-weighting overall confidence when the two extractors disagree, routing
   * irreconcilable docs to review_queue. For now this is a documented stub that
   * returns the PRIMARY result unchanged so the pipeline stays deterministic.
   */
  private arbitrate(primary: ExtractorResult, _secondary: ExtractorResult): ExtractorResult {
    // NOTE: wiring is live; merge logic is intentionally deferred.
    return primary;
  }
}

// ---------------------------------------------------------------------------
// Pipeline construction
// ---------------------------------------------------------------------------

/**
 * Build the configured ordered extractor pipeline for this environment.
 *
 * Returns references to the concrete (stub) extractor classes that the
 * extraction agent implements in src/extraction/*:
 *   - SenateHtmlExtractor (senate_html)
 *   - TextPdfExtractor    (text_pdf)
 *   - VisionLlmExtractor  (scanned_pdf — uses GEMINI_API_KEY)
 *
 * The classifier picks a docKind; the queue handler iterates this pipeline and
 * uses the first extractor whose canHandle() returns true. The vision extractor
 * may be wrapped in an ArbitratingExtractor when a secondary is configured.
 *
 * TODO(extraction-agent): wire the real secondary for arbitration once a second
 * provider exists; the ArbitratingExtractor switch is already in place.
 */
export function buildExtractorPipeline(env: Env): Extractor[] {
  const senateHtml = new SenateHtmlExtractor();
  const textPdf = new TextPdfExtractor();
  const visionLlm = new VisionLlmExtractor(env);

  // Vision extractor is arbitration-ready. No secondary configured yet, so the
  // switch resolves to the primary until one is supplied here.
  const visionArbitrated = new ArbitratingExtractor(visionLlm, env /*, secondary */);

  return [senateHtml, textPdf, visionArbitrated];
}

// ---------------------------------------------------------------------------
// Re-exported concrete extractor stub classes (implemented by extraction agent)
// ---------------------------------------------------------------------------

import { SenateHtmlExtractor } from '../extraction/senateHtml';
import { TextPdfExtractor } from '../extraction/textPdf';
import { VisionLlmExtractor } from '../extraction/visionLlm';

export { SenateHtmlExtractor, TextPdfExtractor, VisionLlmExtractor };
