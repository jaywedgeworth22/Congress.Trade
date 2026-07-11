import { get } from './db';

export interface ReadinessResult {
  ok: boolean;
  db: boolean;
  schema: boolean;
  missing: string[];
}

const REQUIRED_PROBES: Array<[string, string, boolean?]> = [
  ['filings', 'SELECT doc_id, first_seen_at, filed_date, page_count, raw_bytes FROM filings LIMIT 0'],
  [
    'transactions',
    `SELECT row_key, disclosure_available_at, deprecated_at, asset_type_name,
            amount_min, amount_max, est_value
       FROM transactions LIMIT 0`,
  ],
  ['subscriptions', 'SELECT id, secret, filters FROM subscriptions LIMIT 0'],
  [
    'deliveries',
    `SELECT id, subscription_id, tx_id, status, attempts, last_error, updated_at,
            claim_token, lease_until
       FROM deliveries LIMIT 0`,
  ],
  [
    'delivery_outbox',
    `SELECT tx_id, status, attempts, dead_letter_cycles, available_at, last_error,
            created_at, updated_at
       FROM delivery_outbox LIMIT 0`,
  ],
  [
    'ingestion_outbox',
    `SELECT doc_id, chamber, source_url, status, attempts, dead_letter_cycles,
            available_at, last_error, created_at, updated_at
       FROM ingestion_outbox LIMIT 0`,
  ],
  ['sse_leases', 'SELECT id, subscription_id, client_id, expires_at, created_at FROM sse_leases LIMIT 0'],
  [
    'source_attempts',
    'SELECT id, source, attempted_at, outcome, new_count, error FROM source_attempts LIMIT 0',
  ],
  [
    'users',
    `SELECT id, email, stripe_customer_id, stripe_subscription_id, plan,
            subscription_status, current_period_end, cancel_at_period_end, trial_end
       FROM users LIMIT 0`,
  ],
  [
    'stripe_webhook_events',
    `SELECT event_id, event_type, received_at, processed_at, claim_token, claim_expires_at
       FROM stripe_webhook_events LIMIT 0`,
  ],
  [
    'stripe_subscription_event_state',
    `SELECT subscription_id, customer_id, last_event_created, last_event_priority,
            last_event_id, last_event_type, updated_at
       FROM stripe_subscription_event_state LIMIT 0`,
  ],
  [
    'review_queue',
    `SELECT doc_id, resolved, agreement_attempted_at, agreement_attempts,
            agreement_tier, agreement_next_attempt_at, agreement_claim_token,
            agreement_claimed_at, agreement_legacy_replay_at,
            agreement_suppressed_at, agreement_suppression_reason, review_revision
       FROM review_queue LIMIT 0`,
  ],
  ['llm_budget', 'SELECT day, reads FROM llm_budget LIMIT 0'],
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
  [
    'idx_transactions_live_doc_source_rowkey',
    `SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_transactions_live_doc_source_rowkey'
        AND UPPER(sql) LIKE 'CREATE UNIQUE INDEX%'
        AND UPPER(sql) LIKE '%DEPRECATED_AT IS NULL%'`,
    true,
  ],
  [
    'idx_users_stripe_customer',
    `SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_users_stripe_customer'
        AND UPPER(sql) LIKE 'CREATE UNIQUE INDEX%'`,
    true,
  ],
  ...[
    'idx_tx_cursor',
    'idx_delivery_outbox_ready',
    'idx_ingestion_outbox_ready',
    'idx_deliveries_lease',
    'idx_sse_leases_expiry',
    'idx_sse_leases_subscription',
    'idx_sse_leases_client',
    'idx_source_attempts_source_time',
    'idx_stripe_webhook_events_claim_expiry',
    'idx_stripe_subscription_event_customer',
    'idx_review_queue_agreement_eligible',
    'idx_review_queue_agreement_claim',
    'idx_review_queue_agreement_suppressed',
  ].map((name): [string, string, boolean] => [
    name,
    `SELECT name FROM sqlite_master WHERE type = 'index' AND name = '${name}'`,
    true,
  ]),
  [
    'trg_transactions_cursor',
    `SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name = 'trg_transactions_cursor'`,
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
