import { describe, expect, it } from 'vitest';
// Worker production code intentionally omits Node typings; this test validates
// checked-in SQL/config artifacts under Vitest's Node runtime.
import { existsSync, readFileSync } from 'node:fs';
import { buildAdminRouter } from '../routes';

const app = buildAdminRouter();
const testModuleUrl = (import.meta as ImportMeta & { readonly url: string }).url;

function setting(text: string, key: string): string {
  const match = text.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"$`, 'm'));
  expect(match, `${key} must be explicit`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('review queue durable state migration', () => {
  it('uses collision-safe 0033-0037 files and guards replay + human holds', () => {
    const deliveryMigration = (new URL('../../../migrations/0030_delivery_outbox.sql', testModuleUrl) as any);
    const migration33 = (new URL('../../../migrations/0033_doc_complexity_signals.sql', testModuleUrl) as any);
    const migration34 = (new URL('../../../migrations/0034_agreement_cascade.sql', testModuleUrl) as any);
    const migration35 = (new URL('../../../migrations/0035_llm_budget.sql', testModuleUrl) as any);
    const migration36 = (new URL('../../../migrations/0036_review_resolution_safety.sql', testModuleUrl) as any);
    const migration37 = (new URL('../../../migrations/0037_review_revision.sql', testModuleUrl) as any);
    const migration38 = (new URL('../../../migrations/0038_benchmark_runs.sql', testModuleUrl) as any);

    expect(existsSync(deliveryMigration)).toBe(true);
    expect(existsSync(migration33)).toBe(true);
    expect(existsSync(migration34)).toBe(true);
    expect(existsSync(migration35)).toBe(true);
    expect(existsSync(migration36)).toBe(true);
    expect(existsSync(migration37)).toBe(true);
    expect(existsSync(migration38)).toBe(true);
    expect(existsSync((new URL('../../../migrations/0025_doc_complexity_signals.sql', testModuleUrl) as any))).toBe(false);
    expect(existsSync((new URL('../../../migrations/0026_agreement_cascade.sql', testModuleUrl) as any))).toBe(false);
    expect(existsSync((new URL('../../../migrations/0027_llm_budget.sql', testModuleUrl) as any))).toBe(false);
    expect(existsSync((new URL('../../../migrations/0030_doc_complexity_signals.sql', testModuleUrl) as any))).toBe(false);
    expect(existsSync((new URL('../../../migrations/0031_agreement_cascade.sql', testModuleUrl) as any))).toBe(false);
    expect(existsSync((new URL('../../../migrations/0032_llm_budget.sql', testModuleUrl) as any))).toBe(false);

    expect(readFileSync(deliveryMigration, 'utf8') as string).toMatch(
      /CREATE TABLE IF NOT EXISTS delivery_outbox/i,
    );
    const sql = readFileSync(migration34, 'utf8') as string;
    expect(sql).toMatch(/ADD COLUMN agreement_next_attempt_at TEXT/i);
    expect(sql).toMatch(/ADD COLUMN agreement_claim_token TEXT/i);
    expect(sql).toMatch(/ADD COLUMN agreement_claimed_at TEXT/i);
    expect(sql).toMatch(/ADD COLUMN agreement_legacy_replay_at TEXT/i);
    expect(sql).toMatch(/idx_review_queue_agreement_eligible/i);
    expect(sql).toMatch(/idx_review_queue_agreement_claim/i);
    expect(sql).toMatch(/WHERE resolved = 0[\s\S]*agreement_legacy_replay_at IS NULL/i);
    expect(sql).toMatch(/agreement_attempted_at >= '2026-06-26T00:00:00\.000Z'/i);
    expect(sql).toMatch(/agreement_attempted_at < '2026-07-11T00:00:00\.000Z'/i);

    const safetySql = readFileSync(migration36, 'utf8') as string;
    expect(safetySql).toMatch(/ADD COLUMN agreement_suppressed_at TEXT/i);
    expect(safetySql).toMatch(/reason LIKE 'unpublished:%'/i);
    const createLiveIndex = safetySql.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_live_doc_source_rowkey');
    const dropOldIndex = safetySql.indexOf('DROP INDEX IF EXISTS idx_transactions_doc_source_rowkey');
    expect(createLiveIndex).toBeGreaterThan(-1);
    expect(dropOldIndex).toBeGreaterThan(createLiveIndex);
    expect(safetySql).toMatch(/deprecated_at IS NULL/i);
    expect(safetySql).not.toMatch(/review_delivery_outbox/i);
    expect(readFileSync(migration37, 'utf8') as string).toMatch(
      /ADD COLUMN review_revision INTEGER NOT NULL DEFAULT 1/i,
    );
    expect(readFileSync(migration38, 'utf8') as string).toMatch(
      /CREATE TABLE IF NOT EXISTS benchmark_model_results/i,
    );
  });

  it('mirrors lease fields, indexes, and guarded replay in POST /migrate order', async () => {
    const statements: string[] = [];
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return this;
          },
          async run() {
            statements.push(sql);
            return { success: true, meta: { changes: 1 } };
          },
        };
      },
    } as unknown as D1Database;

    const res = await app.request(
      '/migrate',
      { method: 'POST', headers: { Authorization: 'Bearer admin-secret' } },
      { ADMIN_TOKEN: 'admin-secret', DB: db } as never,
    );

    expect(res.status).toBe(200);
    const addLegacy = statements.findIndex((sql) => /ADD COLUMN agreement_legacy_replay_at/i.test(sql));
    const eligibleIndex = statements.findIndex((sql) => /idx_review_queue_agreement_eligible/i.test(sql));
    const replay = statements.findIndex((sql) => /agreement_legacy_replay_at = CURRENT_TIMESTAMP/i.test(sql));
    const addSuppression = statements.findIndex((sql) => /ADD COLUMN agreement_suppressed_at/i.test(sql));
    const createLiveIndex = statements.findIndex((sql) => /idx_transactions_live_doc_source_rowkey/i.test(sql));
    const dropOldIndex = statements.findIndex((sql) => /DROP INDEX IF EXISTS idx_transactions_doc_source_rowkey/i.test(sql));
    const outbox = statements.findIndex((sql) => /CREATE TABLE IF NOT EXISTS delivery_outbox/i.test(sql));
    const addReviewRevision = statements.findIndex((sql) => /ADD COLUMN review_revision/i.test(sql));
    const benchmarkRuns = statements.findIndex((sql) => /CREATE TABLE IF NOT EXISTS benchmark_runs/i.test(sql));
    expect(outbox).toBeGreaterThan(-1);
    expect(addLegacy).toBeGreaterThan(-1);
    expect(addLegacy).toBeGreaterThan(outbox);
    expect(eligibleIndex).toBeGreaterThan(addLegacy);
    expect(replay).toBeGreaterThan(eligibleIndex);
    expect(statements[replay]).toMatch(/WHERE resolved = 0[\s\S]*agreement_legacy_replay_at IS NULL/i);
    expect(addSuppression).toBeGreaterThan(replay);
    expect(createLiveIndex).toBeGreaterThan(addSuppression);
    expect(dropOldIndex).toBeGreaterThan(createLiveIndex);
    expect(addReviewRevision).toBeGreaterThan(dropOldIndex);
    expect(benchmarkRuns).toBeGreaterThan(addReviewRevision);
    expect(statements.some((sql) => /review_delivery_outbox/i.test(sql))).toBe(false);
  });
});

describe('review queue autonomous configuration', () => {
  it('pins distinct A/B/C vendors and all retry, budget, and big-doc controls', () => {
    const wrangler = readFileSync((new URL('../../../wrangler.toml', testModuleUrl) as any), 'utf8') as string;
    const devExample = readFileSync((new URL('../../../.dev.vars.example', testModuleUrl) as any), 'utf8') as string;
    const keys = [
      'AGREEMENT_AUTOPUBLISH_MODEL_A',
      'AGREEMENT_AUTOPUBLISH_MODEL_B',
      'AGREEMENT_MODEL_C',
      'AGREEMENT_AUTOPUBLISH_LIMIT',
      'AGREEMENT_MAX_ATTEMPTS',
      'AGREEMENT_DAILY_LLM_BUDGET',
      'AGREEMENT_BIG_DOC_START_TIER2',
      'AGREEMENT_BIG_DOC_PAGE_THRESHOLD',
      'AGREEMENT_BIG_DOC_BYTES_THRESHOLD',
      'AGREEMENT_TEXT_NORMALIZATION',
    ];

    for (const key of keys) expect(setting(devExample, key)).toBe(setting(wrangler, key));
    const providers = [
      setting(wrangler, 'AGREEMENT_AUTOPUBLISH_MODEL_A').split(':')[0],
      setting(wrangler, 'AGREEMENT_AUTOPUBLISH_MODEL_B').split(':')[0],
      setting(wrangler, 'AGREEMENT_MODEL_C').split(':')[0],
    ];
    const models = [
      setting(wrangler, 'AGREEMENT_AUTOPUBLISH_MODEL_A'),
      setting(wrangler, 'AGREEMENT_AUTOPUBLISH_MODEL_B'),
      setting(wrangler, 'AGREEMENT_MODEL_C'),
    ];
    expect(new Set(models).size).toBe(3); // Distinct models
    expect(providers).toEqual(['openrouter', 'openrouter', 'openrouter']);
    expect(setting(wrangler, 'AGREEMENT_DAILY_LLM_BUDGET')).toBe('300');
    expect(setting(wrangler, 'AGREEMENT_BIG_DOC_START_TIER2')).toBe('true');
  });
});
