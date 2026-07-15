import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  handleAgreementCheck,
  processAgreementCascadeTier2,
  type AgreementModelsC,
} from '../agreement';

/**
 * Tiered agreement cascade (money path). Exercises the escalation ladder end to
 * end with a scenario-driven in-memory D1 fake:
 *   Tier 1  A + B unanimous  → publish (regression: unchanged behavior).
 *   Tier 1  A + B disagree   → enqueue an escalationTier:2 check (attempt cap
 *                              permitting); at the cap, leave in human review.
 *   Tier 2  A + B + C unanimous → publish.
 *   Tier 3  2-of-3 majority with per-field majority on type/date/amount → publish
 *                              with a resolvedBy:'agreement-cascade' audit row.
 *   Tier 3  no amount-bracket majority → do NOT publish (human review).
 *   Tier 3  hard-fail flag on the majority set → do NOT publish (human review).
 * Providers are stubbed via global.fetch; models are pinned to openai (A),
 * anthropic (B), mistral (C) so each provider maps to one candidate.
 */

// --- Row + response helpers ------------------------------------------------
const row = (
  ticker: string,
  txType: string,
  amountRange: string | null,
  extra: Record<string, unknown> = {},
) => ({
  ticker,
  assetName: `${ticker} Inc.`,
  txDate: '2026-06-19',
  txType,
  amountRange,
  isOption: false,
  capGainsOver200: false,
  confidence: 0.9,
  ...extra,
});
const asJson = (rows: unknown[]) => JSON.stringify(rows);

const AB = '$1,001 - $15,000';
const AB2 = '$15,001 - $50,000';
const AB3 = '$50,001 - $100,000';

/** Stub openai (A) / anthropic (B) / mistral (C) with per-provider payloads. */
function stub(openai: string, anthropic: string, mistral?: string) {
  const seen: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('api.openai.com')) { seen.push('openai'); return { ok: true, json: async () => ({ output_text: openai, choices: [{ message: { content: openai } }] }) } as unknown as Response; }
    if (u.includes('api.anthropic.com')) { seen.push('anthropic'); return { ok: true, json: async () => ({ content: [{ type: 'text', text: anthropic }] }) } as unknown as Response; }
    if (u.includes('api.mistral.ai') && mistral) { seen.push('mistral'); return { ok: true, json: async () => ({ document_annotation: mistral }) } as unknown as Response; }
    return { ok: false, status: 404, text: async () => 'nope' } as unknown as Response;
  }));
  return seen;
}

interface Captured {
  inserted: unknown[][];
  resolved: string[];
  sent: unknown[];
  reviewFlags: Array<{ reason: unknown; payload: unknown }>;
  decisions: Array<{ action: unknown; source: unknown; reason: unknown; payload: Record<string, unknown> | null }>;
}

function makeEnv(opts: { pageCount?: number | null; rawBytes?: number | null; priorAttempts?: number; maxAttempts?: string; env?: Record<string, unknown> } = {}) {
  const cap: Captured = { inserted: [], resolved: [], sent: [], reviewFlags: [], decisions: [] };
  const review = {
    resolved: 0,
    attempts: opts.priorAttempts ?? 0,
    tier: null as number | null,
    nextAttemptAt: null as string | null,
    claimToken: null as string | null,
    claimedAt: null as string | null,
    revision: 1,
  };
  const db = {
    prepare(sql: string) {
      return {
        params: [] as unknown[],
        bind(...p: unknown[]) { this.params = p; return this; },
        async first<T>() {
          if (/SELECT doc_id, chamber, filer_id/i.test(sql)) {
            return { doc_id: this.params[0], chamber: 'house', filer_id: 'P1', filing_type: 'P', filed_date: '2026-06-20', source_url: 'u', raw_object_key: 'raw/x', ingest_status: 'needs_review', doc_kind: 'scanned_pdf', extractor: null, model_version: null, confidence: null, first_seen_at: '2026-06-20', source_updated_at: null, error: null } as T;
          }
          if (/SELECT page_count, raw_bytes FROM filings/i.test(sql)) {
            return { page_count: opts.pageCount ?? null, raw_bytes: opts.rawBytes ?? null } as T;
          }
          if (/SELECT resolved, agreement_attempts, agreement_tier/i.test(sql)) {
            return {
              resolved: review.resolved,
              agreement_attempts: review.attempts,
              agreement_tier: review.tier,
              agreement_next_attempt_at: review.nextAttemptAt,
              agreement_claim_token: review.claimToken,
              agreement_claimed_at: review.claimedAt,
              agreement_suppressed_at: null,
              agreement_suppression_reason: null,
              review_revision: review.revision,
            } as T;
          }
          if (/SELECT payload, review_revision FROM review_queue/i.test(sql)) {
            return { payload: null, review_revision: review.revision } as T;
          }
          return null as T | null;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
        async run() {
          if (/SET agreement_attempts = \?,\s*agreement_tier = \?/i.test(sql)) {
            const [nextAttempts, tier, , token, claimedAt, , expectedToken, observedAttempts, max] = this.params as [number, number, string, string, string, string, string, number, number];
            if (review.resolved === 0 && review.claimToken === expectedToken && review.attempts === observedAttempts && review.attempts < max) {
              review.attempts = nextAttempts;
              review.tier = tier;
              review.claimToken = token;
              review.claimedAt = claimedAt;
              review.nextAttemptAt = null;
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (/SET agreement_claimed_at = \?, agreement_next_attempt_at = NULL/i.test(sql)) {
            const [claimedAt, , expectedToken, max] = this.params as [string, string, string, number];
            if (review.resolved === 0 && review.claimToken === expectedToken && review.attempts < max) {
              review.claimedAt = claimedAt;
              review.nextAttemptAt = null;
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (/SET agreement_claim_token = \?, agreement_claimed_at = \?, agreement_next_attempt_at = NULL/i.test(sql)) {
            const [token, claimedAt, , max] = this.params as [string, string, string, number];
            if (review.resolved === 0 && review.attempts < max && review.claimToken === null) {
              review.claimToken = token;
              review.claimedAt = claimedAt;
              review.nextAttemptAt = null;
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (/SET agreement_claim_token = \?, agreement_claimed_at = \?/i.test(sql)) {
            const [token, claimedAt, , expected] = this.params as [string, string, string, string];
            if (review.resolved === 0 && (review.claimToken === expected || review.claimToken === null)) {
              review.claimToken = token;
              review.claimedAt = claimedAt;
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (/INSERT (?:OR IGNORE )?INTO transactions/i.test(sql)) {
            const guardToken = String(this.params[this.params.length - 1]);
            if (review.resolved === 0 && review.claimToken === guardToken) {
              cap.inserted.push(this.params);
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          else if (/INSERT INTO ingestion_decisions/i.test(sql)) {
            // (id, doc_id, action, source, actor, reason, payload, transaction_ids, created_at)
            const payloadRaw = this.params[6];
            cap.decisions.push({
              action: this.params[2], source: this.params[3], reason: this.params[5],
              payload: typeof payloadRaw === 'string' ? JSON.parse(payloadRaw) : null,
            });
          } else if (/UPDATE review_queue\s+SET reason/i.test(sql)) {
            const expectedToken = /agreement_claim_token = \?/i.test(sql) ? this.params[3] : undefined;
            if (review.resolved === 0 && (expectedToken === undefined || expectedToken === review.claimToken)) {
              review.revision += 1;
              cap.reviewFlags.push({ reason: this.params[0], payload: typeof this.params[1] === 'string' ? JSON.parse(this.params[1] as string) : this.params[1] });
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          } else if (/SET resolved = 1,/i.test(sql)) {
            const [docId, expectedToken] = this.params as [string, string];
            if (review.resolved === 0 && review.claimToken === expectedToken) {
              review.resolved = 1;
              review.claimToken = null;
              review.claimedAt = null;
              review.revision += 1;
              cap.resolved.push(docId);
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          } else if (/agreement_claim_token = NULL/i.test(sql)) {
            const expectedToken = String(this.params[this.params.length - 1]);
            if (review.claimToken === expectedToken) {
              if (/agreement_attempts = MAX\(COALESCE/i.test(sql)) review.attempts = Math.max(review.attempts, Number(this.params[0]));
              review.claimToken = null;
              review.claimedAt = null;
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
    },
  } as unknown as D1Database;

  const env = {
    AGREEMENT_AUTOPUBLISH_ENABLED: 'true',
    AGREEMENT_HOUSE_MODEL_C: 'openai:gpt-4o',
    AGREEMENT_HOUSE_MODEL_D: 'anthropic:claude-haiku-4-5',
    AGREEMENT_HOUSE_MODEL_E: 'mistral:mistral-ocr-latest',
    AGREEMENT_MAX_ATTEMPTS: opts.maxAttempts,
    OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', MISTRAL_API_KEY: 'k',
    DB: db,
    RAW_FILES: { get: async () => ({ arrayBuffer: async () => new TextEncoder().encode('%PDF').buffer }) },
    INGEST_QUEUE: { send: async (m: unknown) => { cap.sent.push(m); } },
    DELIVERY_QUEUE: { send: async () => {}, sendBatch: async () => {} },
    ...(opts.env ?? {}),
  } as never;
  return { env, cap, review };
}

const MODELS_C: AgreementModelsC = {
  a: { provider: 'openai', model: 'gpt-5.6-terra' },
  b: { provider: 'anthropic', model: 'claude-haiku-4-5' },
  c: { provider: 'mistral', model: 'mistral-ocr-latest' },
};

describe('agreement cascade — tier 1', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('tier-1 unanimous publishes (regression)', async () => {
    stub(asJson([row('AAPL', 'P', AB)]), asJson([row('AAPL', 'P', AB)]));
    const { env, cap } = makeEnv();
    await handleAgreementCheck(env, 'H-1', 'raw/H-1'); // no tier → tier 1
    expect(cap.inserted).toHaveLength(1);
    expect(cap.resolved).toContain('H-1');
    expect(cap.sent).toHaveLength(0); // agreed → no escalation
  });

  it('tier-1 disagreement enqueues an escalationTier:2 check (under the cap)', async () => {
    stub(asJson([row('AAPL', 'P', AB)]), asJson([row('MSFT', 'S', AB)]));
    const { env, cap } = makeEnv();
    await handleAgreementCheck(env, 'H-2', 'raw/H-2');
    expect(cap.inserted).toHaveLength(0);
    expect(cap.sent).toEqual([
      expect.objectContaining({
        type: 'agreement.check', docId: 'H-2', rawObjectKey: 'raw/H-2', escalationTier: 2,
        claimToken: expect.any(String),
      }),
    ]);
  });

  it('stops escalating and flags human review once AGREEMENT_MAX_ATTEMPTS is reached', async () => {
    stub(asJson([row('AAPL', 'P', AB)]), asJson([row('MSFT', 'S', AB)]));
    const { env, cap } = makeEnv({ maxAttempts: '1' }); // first attempt already at the cap
    await handleAgreementCheck(env, 'H-3', 'raw/H-3');
    expect(cap.sent).toHaveLength(0); // no escalation
    expect(cap.inserted).toHaveLength(0);
    expect(cap.reviewFlags).toHaveLength(1);
    expect(cap.reviewFlags[0].reason).toBe('agreement_cascade_unresolved');
  });

  it('a big doc (page_count over threshold) starts directly at tier 2', async () => {
    const seen = stub(asJson([row('AAPL', 'P', AB)]), asJson([row('AAPL', 'P', AB)]), asJson([row('AAPL', 'P', AB)]));
    const { env, cap } = makeEnv({ pageCount: 20 });
    await handleAgreementCheck(env, 'H-4', 'raw/H-4'); // fresh, but big → tier 2
    expect(seen).toContain('mistral'); // the third model was consulted
    expect(cap.inserted).toHaveLength(1); // 3-way unanimous publish
  });
});

describe('agreement cascade — tier 2 / tier 3', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('3-way unanimous publishes (tier 2)', async () => {
    stub(asJson([row('AAPL', 'P', AB)]), asJson([row('AAPL', 'P', AB)]), asJson([row('AAPL', 'P', AB)]));
    const { env, cap } = makeEnv();
    const res = await processAgreementCascadeTier2(env, MODELS_C, 'H-5', 'raw/H-5', false);
    expect(res).toMatchObject({ outcome: 'published', tier: 2 });
    expect(cap.inserted).toHaveLength(1);
    const decision = cap.decisions.find((d) => d.action === 'agreement_published');
    expect(decision?.payload).toMatchObject({ resolvedBy: 'agreement-cascade', tier: 2, unanimous: true });
  });

  it('2-of-3 majority on every material field publishes with a cascade audit (tier 3)', async () => {
    // Same row identity in all reads; C disagrees on owner, so exact tier-2
    // unanimity fails and tier 3 resolves the 2-of-3 material-field majority.
    stub(
      asJson([row('AAPL', 'P', AB, { owner: 'self' })]),
      asJson([row('AAPL', 'P', AB, { owner: 'self' })]),
      asJson([row('AAPL', 'P', AB, { owner: 'spouse' })]),
    );
    const { env, cap } = makeEnv();
    const res = await processAgreementCascadeTier2(env, MODELS_C, 'H-6', 'raw/H-6', false);
    expect(res).toMatchObject({ outcome: 'published', tier: 3 });
    expect(cap.inserted).toHaveLength(1); // only the majority AAPL row
    const decision = cap.decisions.find((d) => d.action === 'agreement_published');
    expect(decision?.payload).toMatchObject({ resolvedBy: 'agreement-cascade', tier: 3 });
    expect(decision?.payload?.votes).toBeTruthy(); // per-field vote summary present
  });

  it('does not drop a minority-only extra row', async () => {
    stub(
      asJson([row('AAPL', 'P', AB)]),
      asJson([row('AAPL', 'P', AB)]),
      asJson([row('AAPL', 'P', AB), row('MSFT', 'P', AB)]),
    );
    const { env, cap } = makeEnv();
    const res = await processAgreementCascadeTier2(env, MODELS_C, 'H-minority-extra', 'raw/x', false);
    expect(res).toMatchObject({ outcome: 'review_flagged', tier: 3 });
    expect(String(res.reason)).toContain('minority_extra_row');
    expect(cap.inserted).toHaveLength(0);
  });

  it('a majority row WITHOUT an amount-bracket majority does NOT publish (tier 3)', async () => {
    // All three read AAPL but each a different amount.
    stub(
      asJson([row('AAPL', 'P', AB)]),
      asJson([row('AAPL', 'P', AB2)]),
      asJson([row('AAPL', 'P', AB3)]),
    );
    const { env, cap } = makeEnv();
    const res = await processAgreementCascadeTier2(env, MODELS_C, 'H-7', 'raw/H-7', false);
    expect(res.outcome).toBe('review_flagged');
    expect(String(res.reason)).toContain('field_disagreement');
    expect(cap.inserted).toHaveLength(0);
    expect(cap.reviewFlags).toHaveLength(1);
    const decision = cap.decisions.find((d) => d.action === 'review_opened');
    expect(decision?.payload).toMatchObject({ resolvedBy: 'agreement-cascade', priority: 'high', tier: 3 });
  });

  it('a multi-lot majority row (same key, distinct brackets) is NOT auto-published (tier 3)', async () => {
    // A + B each disclose TWO AAPL purchases the same day (same ticker|date|type,
    // different dollar brackets) — a real multi-lot filing. A also reads an extra
    // TSLA row so the row-set is not 3-way unanimous → tier 3. The consensus key
    // excludes amount, so the second AAPL lot would silently vanish; the guard
    // must leave the whole doc in review instead of publishing an incomplete set.
    stub(
      asJson([row('AAPL', 'P', AB), row('AAPL', 'P', AB3), row('TSLA', 'P', AB)]),
      asJson([row('AAPL', 'P', AB), row('AAPL', 'P', AB3)]),
      asJson([row('AAPL', 'P', AB), row('AAPL', 'P', AB3)]),
    );
    const { env, cap } = makeEnv();
    const res = await processAgreementCascadeTier2(env, MODELS_C, 'H-9', 'raw/H-9', false);
    expect(res.outcome).toBe('review_flagged');
    expect(String(res.reason)).toContain('multi_lot');
    expect(cap.inserted).toHaveLength(0);
    expect(cap.reviewFlags).toHaveLength(1);
  });

  it('a hard-fail flag on the majority set blocks the publish (tier 3)', async () => {
    // A+B agree on a NULL amount (→ no_amount hard-fail); C has a valid bracket.
    stub(asJson([row('AAPL', 'P', null)]), asJson([row('AAPL', 'P', null)]), asJson([row('AAPL', 'P', AB)]));
    const { env, cap } = makeEnv();
    const res = await processAgreementCascadeTier2(env, MODELS_C, 'H-8', 'raw/H-8', false);
    expect(res.outcome).toBe('review_flagged');
    expect(String(res.reason)).toContain('hard_fail');
    expect(cap.inserted).toHaveLength(0);
    expect(cap.reviewFlags).toHaveLength(1);
  });
});
