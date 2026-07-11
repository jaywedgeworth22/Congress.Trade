import { describe, expect, it } from 'vitest';
// Worker production code intentionally omits Node typings; this test validates
// checked-in SQL/config artifacts under Vitest's Node runtime.
// @ts-expect-error -- node:fs is test-only and absent from the Worker tsconfig types.
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
  it('uses collision-safe 0030-0033 files and guards replay + human holds', () => {
    const migration30 = new URL('../../../migrations/0030_doc_complexity_signals.sql', testModuleUrl);
    const migration31 = new URL('../../../migrations/0031_agreement_cascade.sql', testModuleUrl);
    const migration32 = new URL('../../../migrations/0032_llm_budget.sql', testModuleUrl);
    const migration33 = new URL('../../../migrations/0033_review_resolution_safety.sql', testModuleUrl);

    expect(existsSync(migration30)).toBe(true);
    expect(existsSync(migration31)).toBe(true);
    expect(existsSync(migration32)).toBe(true);
    expect(existsSync(migration33)).toBe(true);
    expect(existsSync(new URL('../../../migrations/0025_doc_complexity_signals.sql', testModuleUrl))).toBe(false);
    expect(existsSync(new URL('../../../migrations/0026_agreement_cascade.sql', testModuleUrl))).toBe(false);
    expect(existsSync(new URL('../../../migrations/0027_llm_budget.sql', testModuleUrl))).toBe(false);

    const sql = readFileSync(migration31, 'utf8') as string;
    expect(sql).toMatch(/ADD COLUMN agreement_next_attempt_at TEXT/i);
    expect(sql).toMatch(/ADD COLUMN agreement_claim_token TEXT/i);
    expect(sql).toMatch(/ADD COLUMN agreement_claimed_at TEXT/i);
    expect(sql).toMatch(/ADD COLUMN agreement_legacy_replay_at TEXT/i);
    expect(sql).toMatch(/idx_review_queue_agreement_eligible/i);
    expect(sql).toMatch(/idx_review_queue_agreement_claim/i);
    expect(sql).toMatch(/WHERE resolved = 0[\s\S]*agreement_legacy_replay_at IS NULL/i);
    expect(sql).toMatch(/agreement_attempted_at >= '2026-06-26T00:00:00\.000Z'/i);
    expect(sql).toMatch(/agreement_attempted_at < '2026-07-11T00:00:00\.000Z'/i);

    const safetySql = readFileSync(migration33, 'utf8') as string;
    expect(safetySql).toMatch(/ADD COLUMN agreement_suppressed_at TEXT/i);
    expect(safetySql).toMatch(/reason LIKE 'unpublished:%'/i);
    const createLiveIndex = safetySql.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_live_doc_source_rowkey');
    const dropOldIndex = safetySql.indexOf('DROP INDEX IF EXISTS idx_transactions_doc_source_rowkey');
    expect(createLiveIndex).toBeGreaterThan(-1);
    expect(dropOldIndex).toBeGreaterThan(createLiveIndex);
    expect(safetySql).toMatch(/deprecated_at IS NULL/i);
    expect(safetySql).toMatch(/CREATE TABLE IF NOT EXISTS review_delivery_outbox/i);
    expect(safetySql).toMatch(/idx_review_delivery_outbox_pending/i);
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
    const outbox = statements.findIndex((sql) => /CREATE TABLE IF NOT EXISTS review_delivery_outbox/i.test(sql));
    expect(addLegacy).toBeGreaterThan(-1);
    expect(eligibleIndex).toBeGreaterThan(addLegacy);
    expect(replay).toBeGreaterThan(eligibleIndex);
    expect(statements[replay]).toMatch(/WHERE resolved = 0[\s\S]*agreement_legacy_replay_at IS NULL/i);
    expect(addSuppression).toBeGreaterThan(replay);
    expect(createLiveIndex).toBeGreaterThan(addSuppression);
    expect(dropOldIndex).toBeGreaterThan(createLiveIndex);
    expect(outbox).toBeGreaterThan(dropOldIndex);
  });
});

describe('review queue autonomous configuration', () => {
  it('pins distinct A/B/C vendors and all retry, budget, and big-doc controls', () => {
    const wrangler = readFileSync(new URL('../../../wrangler.toml', testModuleUrl), 'utf8') as string;
    const devExample = readFileSync(new URL('../../../.dev.vars.example', testModuleUrl), 'utf8') as string;
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
    ];

    for (const key of keys) expect(setting(devExample, key)).toBe(setting(wrangler, key));
    const providers = [
      setting(wrangler, 'AGREEMENT_AUTOPUBLISH_MODEL_A').split(':')[0],
      setting(wrangler, 'AGREEMENT_AUTOPUBLISH_MODEL_B').split(':')[0],
      setting(wrangler, 'AGREEMENT_MODEL_C').split(':')[0],
    ];
    expect(new Set(providers).size).toBe(3);
    expect(providers).toEqual(['mistral', 'openai', 'anthropic']);
    expect(setting(wrangler, 'AGREEMENT_DAILY_LLM_BUDGET')).toBe('300');
    expect(setting(wrangler, 'AGREEMENT_BIG_DOC_START_TIER2')).toBe('true');
  });
});
