import { get } from './db';

export interface ReadinessResult {
  ok: boolean;
  db: boolean;
  schema: boolean;
  missing: string[];
}

const REQUIRED_PROBES: Array<[string, string, boolean?]> = [
  ['filings', 'SELECT doc_id, first_seen_at, filed_date FROM filings LIMIT 0'],
  ['transactions', 'SELECT row_key, disclosure_available_at, deprecated_at, asset_type_name FROM transactions LIMIT 0'],
  ['subscriptions', 'SELECT id, secret, filters FROM subscriptions LIMIT 0'],
  ['deliveries', 'SELECT subscription_id, tx_id, attempts, claim_token, lease_until FROM deliveries LIMIT 0'],
  ['delivery_outbox', 'SELECT tx_id, status, available_at, dead_letter_cycles FROM delivery_outbox LIMIT 0'],
  ['ingestion_outbox', 'SELECT doc_id, chamber, source_url, status, available_at, dead_letter_cycles FROM ingestion_outbox LIMIT 0'],
  ['sse_leases', 'SELECT subscription_id, client_id, expires_at FROM sse_leases LIMIT 0'],
  ['source_attempts', 'SELECT source, attempted_at, outcome FROM source_attempts LIMIT 0'],
  ['users', 'SELECT id, email, plan, subscription_status FROM users LIMIT 0'],
  ['review_queue', 'SELECT doc_id, resolved, agreement_attempted_at FROM review_queue LIMIT 0'],
  ['ingestion_decisions', 'SELECT doc_id, action, transaction_ids FROM ingestion_decisions LIMIT 0'],
  ['client_commands', 'SELECT id, user_id, status, idempotency_key FROM client_commands LIMIT 0'],
  ['securities_ref', 'SELECT ticker, sector, market_cap_bucket FROM securities_ref LIMIT 0'],
  ['extraction_runs', 'SELECT id, doc_id, provider, model FROM extraction_runs LIMIT 0'],
  ['dead_letter_events', 'SELECT queue, msg_type, tx_id, attempts FROM dead_letter_events LIMIT 0'],
  [
    'idx_deliveries_subscription_tx',
    `SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_deliveries_subscription_tx'
        AND UPPER(sql) LIKE 'CREATE UNIQUE INDEX%'`,
    true,
  ],
  ...[
    'trg_subscriptions_total_quota',
    'trg_subscriptions_active_insert_quota',
    'trg_subscriptions_active_update_quota',
    'trg_sse_subscription_connection_quota',
    'trg_sse_client_connection_quota',
  ].map((name): [string, string, boolean] => [
    name,
    `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = '${name}'`,
    true,
  ]),
];

/** Readiness requires both D1 connectivity and the schema used by current code. */
export async function checkReadiness(db: D1Database): Promise<ReadinessResult> {
  try {
    await get(db, 'SELECT 1 AS ok');
  } catch {
    return { ok: false, db: false, schema: false, missing: ['database'] };
  }

  const missing: string[] = [];
  for (const [name, sql, requireRow] of REQUIRED_PROBES) {
    try {
      const row = await get(db, sql);
      if (requireRow && !row) missing.push(name);
    } catch {
      missing.push(name);
    }
  }
  return { ok: missing.length === 0, db: true, schema: missing.length === 0, missing };
}
