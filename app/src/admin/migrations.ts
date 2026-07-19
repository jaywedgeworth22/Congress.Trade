import { BENCHMARK_SCHEMA_STATEMENTS } from '../benchmark/schema';

/** Base schema needed before the incremental, idempotent admin migration list. */
export const BASE_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS filers (bioguide_id TEXT PRIMARY KEY, chamber TEXT, full_name TEXT, party TEXT, state TEXT, district TEXT, committees TEXT)`,
  `CREATE TABLE IF NOT EXISTS filings (doc_id TEXT PRIMARY KEY, chamber TEXT, filer_id TEXT, filing_type TEXT, filed_date TEXT, source_url TEXT, raw_object_key TEXT, ingest_status TEXT, doc_kind TEXT, extractor TEXT, model_version TEXT, confidence REAL, first_seen_at TEXT, source_updated_at TEXT, error TEXT)`,
  'CREATE INDEX IF NOT EXISTS idx_filings_status ON filings (ingest_status)',
  'CREATE INDEX IF NOT EXISTS idx_filings_filer ON filings (filer_id)',
  `CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, doc_id TEXT, filer_id TEXT, tx_date TEXT, owner TEXT, asset_name TEXT, ticker TEXT, asset_type TEXT, tx_type TEXT, amount_min INTEGER, amount_max INTEGER, is_option INTEGER, cap_gains_over_200 INTEGER, raw_text TEXT, confidence REAL, source TEXT NOT NULL DEFAULT 'primary', created_at TEXT, cursor_seq INTEGER)`,
  `CREATE TABLE IF NOT EXISTS tx_cursor_seq (seq INTEGER PRIMARY KEY AUTOINCREMENT, tx_id TEXT NOT NULL)`,
  `CREATE TRIGGER IF NOT EXISTS trg_transactions_cursor AFTER INSERT ON transactions FOR EACH ROW WHEN NEW.cursor_seq IS NULL BEGIN INSERT INTO tx_cursor_seq (tx_id) VALUES (NEW.id); UPDATE transactions SET cursor_seq = (SELECT seq FROM tx_cursor_seq WHERE tx_id = NEW.id) WHERE id = NEW.id; END`,
  'CREATE INDEX IF NOT EXISTS idx_tx_cursor ON transactions (cursor_seq)',
  'CREATE INDEX IF NOT EXISTS idx_tx_ticker ON transactions (ticker)',
  'CREATE INDEX IF NOT EXISTS idx_tx_filer ON transactions (filer_id)',
  'CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions (tx_date)',
  'CREATE TABLE IF NOT EXISTS securities_master (ticker TEXT PRIMARY KEY, name TEXT, aliases TEXT)',
  `CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, client_id TEXT, delivery TEXT, target_url TEXT, secret TEXT, filters TEXT, cursor INTEGER, active INTEGER, created_at TEXT)`,
  'CREATE INDEX IF NOT EXISTS idx_subscriptions_active ON subscriptions (active)',
  `CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, subscription_id TEXT, tx_id TEXT, status TEXT, attempts INTEGER, last_error TEXT, updated_at TEXT)`,
  'CREATE INDEX IF NOT EXISTS idx_deliveries_sub ON deliveries (subscription_id)',
  'CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries (status)',
  `CREATE TABLE IF NOT EXISTS poll_config (id INTEGER PRIMARY KEY CHECK (id = 1), schedule TEXT, aggressive_mode INTEGER, updated_at TEXT)`,
  `INSERT OR IGNORE INTO poll_config (id, schedule, aggressive_mode, updated_at) VALUES (1, '[{"daysOfWeek":[1,2,3,4,5],"startHourET":8,"endHourET":19,"intervalSec":300},{"daysOfWeek":[1,2,3,4,5],"startHourET":19,"endHourET":24,"intervalSec":1200},{"daysOfWeek":[1,2,3,4,5],"startHourET":0,"endHourET":8,"intervalSec":1200},{"daysOfWeek":[0,6],"startHourET":0,"endHourET":24,"intervalSec":3600}]', 0, '1970-01-01T00:00:00.000Z')`,
  `CREATE TABLE IF NOT EXISTS review_queue (doc_id TEXT PRIMARY KEY, reason TEXT, payload TEXT, created_at TEXT, resolved INTEGER)`,
  'CREATE INDEX IF NOT EXISTS idx_review_resolved ON review_queue (resolved)',
  `CREATE TABLE IF NOT EXISTS ingest_log (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, polled_at TEXT NOT NULL, new_count INTEGER NOT NULL DEFAULT 0, first_seen_at TEXT)`,
  'CREATE INDEX IF NOT EXISTS idx_ingest_log_source ON ingest_log (source, polled_at)',
] as const;

/**
 * 0020_disclosure_available_generated.sql — point-in-time disclosure
 * availability (first_seen_at/filed_date backfill + generated column + index).
 * Mirrors migrations/0020_disclosure_available_generated.sql's schema exactly,
 * but the backfill UPDATE below preserves any value already present on the
 * transaction and only fills missing columns from a matching filing. POST
 * /api/admin/migrate replays this whole statement list on every call; the
 * one-shot file migration does not need the same replay-safe guard.
 */
export const DISCLOSURE_AVAILABLE_SCHEMA_STATEMENTS = [
  'ALTER TABLE transactions ADD COLUMN first_seen_at TEXT',
  'ALTER TABLE transactions ADD COLUMN filed_date TEXT',
  `UPDATE transactions SET
   first_seen_at = COALESCE(first_seen_at, (SELECT first_seen_at FROM filings WHERE filings.doc_id = transactions.doc_id)),
     filed_date = COALESCE(filed_date, (SELECT filed_date FROM filings WHERE filings.doc_id = transactions.doc_id))
   WHERE EXISTS (
     SELECT 1 FROM filings
      WHERE filings.doc_id = transactions.doc_id
        AND ((transactions.first_seen_at IS NULL AND filings.first_seen_at IS NOT NULL)
          OR (transactions.filed_date IS NULL AND filings.filed_date IS NOT NULL))
   )`,
  `ALTER TABLE transactions ADD COLUMN disclosure_available_at TEXT GENERATED ALWAYS AS (
     COALESCE(first_seen_at, CASE WHEN filed_date IS NOT NULL THEN filed_date || 'T00:00:00.000Z' END, created_at)
   )`,
  'CREATE INDEX IF NOT EXISTS idx_tx_disclosure_available_ticker ON transactions (disclosure_available_at, ticker, id)',
] as const;

export const EST_VALUE_SCHEMA_STATEMENTS = [
  'ALTER TABLE transactions ADD COLUMN est_value REAL',
  `UPDATE transactions SET est_value = CASE
     WHEN amount_min IS NULL AND amount_max IS NULL THEN 0
     WHEN amount_min IS NULL THEN amount_max
     WHEN amount_max IS NULL THEN amount_min
     ELSE (amount_min + amount_max) / 2.0
   END WHERE est_value IS NULL`,
] as const;

export const RELIABILITY_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS delivery_outbox (tx_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, dead_letter_cycles INTEGER NOT NULL DEFAULT 0, available_at TEXT NOT NULL, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS idx_delivery_outbox_ready ON delivery_outbox(status, available_at)',
  'ALTER TABLE delivery_outbox ADD COLUMN dead_letter_cycles INTEGER NOT NULL DEFAULT 0',
  `CREATE TABLE IF NOT EXISTS ingestion_outbox (doc_id TEXT PRIMARY KEY, chamber TEXT NOT NULL, source_url TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, dead_letter_cycles INTEGER NOT NULL DEFAULT 0, available_at TEXT NOT NULL, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS idx_ingestion_outbox_ready ON ingestion_outbox(status, available_at)',
  'ALTER TABLE ingestion_outbox ADD COLUMN dead_letter_cycles INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE deliveries ADD COLUMN claim_token TEXT',
  'ALTER TABLE deliveries ADD COLUMN lease_until TEXT',
  'CREATE INDEX IF NOT EXISTS idx_deliveries_lease ON deliveries(status, lease_until)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_subscription_tx ON deliveries(subscription_id, tx_id)',
  `CREATE TABLE IF NOT EXISTS sse_leases (id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, client_id TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS idx_sse_leases_expiry ON sse_leases(expires_at)',
  'CREATE INDEX IF NOT EXISTS idx_sse_leases_subscription ON sse_leases(subscription_id, expires_at)',
  'CREATE INDEX IF NOT EXISTS idx_sse_leases_client ON sse_leases(client_id, expires_at)',
  `CREATE TRIGGER IF NOT EXISTS trg_sse_subscription_connection_quota BEFORE INSERT ON sse_leases WHEN (SELECT COUNT(*) FROM sse_leases WHERE subscription_id = NEW.subscription_id AND expires_at > NEW.created_at) >= 2 BEGIN SELECT RAISE(ABORT, 'sse subscription connection quota exceeded'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_sse_client_connection_quota BEFORE INSERT ON sse_leases WHEN (SELECT COUNT(*) FROM sse_leases WHERE client_id = NEW.client_id AND expires_at > NEW.created_at) >= 5 BEGIN SELECT RAISE(ABORT, 'sse client connection quota exceeded'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_subscriptions_total_quota BEFORE INSERT ON subscriptions WHEN (SELECT COUNT(*) FROM subscriptions WHERE client_id = NEW.client_id) >= 20 BEGIN SELECT RAISE(ABORT, 'subscription total quota exceeded'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_subscriptions_active_insert_quota BEFORE INSERT ON subscriptions WHEN NEW.active = 1 AND (SELECT COUNT(*) FROM subscriptions WHERE client_id = NEW.client_id AND active = 1) >= 10 BEGIN SELECT RAISE(ABORT, 'subscription active quota exceeded'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_subscriptions_active_update_quota BEFORE UPDATE OF active, client_id ON subscriptions WHEN NEW.active = 1 AND (OLD.active != 1 OR OLD.client_id != NEW.client_id) AND (SELECT COUNT(*) FROM subscriptions WHERE client_id = NEW.client_id AND active = 1 AND id != OLD.id) >= 10 BEGIN SELECT RAISE(ABORT, 'subscription active quota exceeded'); END`,
  `CREATE TABLE IF NOT EXISTS source_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, attempted_at TEXT NOT NULL, outcome TEXT NOT NULL, new_count INTEGER NOT NULL DEFAULT 0, error TEXT)`,
  'CREATE INDEX IF NOT EXISTS idx_source_attempts_source_time ON source_attempts(source, attempted_at DESC)',
] as const;

export const STRIPE_EVENT_SCHEMA_STATEMENTS = [
  'ALTER TABLE stripe_webhook_events ADD COLUMN claim_token TEXT',
  'ALTER TABLE stripe_webhook_events ADD COLUMN claim_expires_at TEXT',
  `CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_claim_expiry
     ON stripe_webhook_events (processed_at, claim_expires_at)`,
  `CREATE TABLE IF NOT EXISTS stripe_subscription_event_state (
     subscription_id TEXT PRIMARY KEY,
     customer_id TEXT NOT NULL,
     last_event_created INTEGER NOT NULL,
     last_event_priority INTEGER NOT NULL,
     last_event_id TEXT NOT NULL,
     last_event_type TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_stripe_subscription_event_customer
     ON stripe_subscription_event_state (customer_id, last_event_created DESC)`,
] as const;

export const REVIEW_COMPLEXITY_SCHEMA_STATEMENTS = [
  'ALTER TABLE filings ADD COLUMN page_count INTEGER',
  'ALTER TABLE filings ADD COLUMN raw_bytes INTEGER',
] as const;

export const REVIEW_AGREEMENT_SCHEMA_STATEMENTS = [
  'ALTER TABLE review_queue ADD COLUMN agreement_attempts INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE review_queue ADD COLUMN agreement_tier INTEGER',
  'ALTER TABLE review_queue ADD COLUMN agreement_next_attempt_at TEXT',
  'ALTER TABLE review_queue ADD COLUMN agreement_claim_token TEXT',
  'ALTER TABLE review_queue ADD COLUMN agreement_claimed_at TEXT',
  'ALTER TABLE review_queue ADD COLUMN agreement_legacy_replay_at TEXT',
  `CREATE INDEX IF NOT EXISTS idx_review_queue_agreement_eligible
     ON review_queue (resolved, agreement_next_attempt_at, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_review_queue_agreement_claim
     ON review_queue (agreement_claim_token, agreement_claimed_at)`,
  `UPDATE review_queue
      SET agreement_attempted_at = NULL,
          agreement_attempts = 0,
          agreement_tier = NULL,
          agreement_next_attempt_at = NULL,
          agreement_claim_token = NULL,
          agreement_claimed_at = NULL
    WHERE resolved = 0
      AND agreement_attempted_at IS NOT NULL
      AND created_at > agreement_attempted_at`,
  `UPDATE review_queue
      SET agreement_attempted_at = NULL,
          agreement_attempts = 0,
          agreement_tier = NULL,
          agreement_next_attempt_at = NULL,
          agreement_claim_token = NULL,
          agreement_claimed_at = NULL,
          agreement_legacy_replay_at = CURRENT_TIMESTAMP
    WHERE resolved = 0
      AND agreement_legacy_replay_at IS NULL
      AND agreement_attempted_at >= '2026-06-26T00:00:00.000Z'
      AND agreement_attempted_at < '2026-07-11T00:00:00.000Z'`,
] as const;

export const REVIEW_BUDGET_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS llm_budget (
     day   TEXT PRIMARY KEY,
     reads INTEGER NOT NULL DEFAULT 0
   )`,
] as const;

export const REVIEW_RESOLUTION_SCHEMA_STATEMENTS = [
  'ALTER TABLE review_queue ADD COLUMN agreement_suppressed_at TEXT',
  'ALTER TABLE review_queue ADD COLUMN agreement_suppression_reason TEXT',
  `UPDATE review_queue
      SET agreement_suppressed_at = COALESCE(agreement_suppressed_at, CURRENT_TIMESTAMP),
          agreement_suppression_reason = COALESCE(agreement_suppression_reason, reason)
    WHERE reason LIKE 'unpublished:%' OR reason LIKE 'rejected:%'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_live_doc_source_rowkey
     ON transactions (doc_id, source, row_key)
     WHERE row_key IS NOT NULL AND deprecated_at IS NULL`,
  'DROP INDEX IF EXISTS idx_transactions_doc_source_rowkey',
  `CREATE INDEX IF NOT EXISTS idx_review_queue_agreement_suppressed
     ON review_queue (resolved, agreement_suppressed_at, created_at)`,
] as const;

export const REVIEW_REVISION_SCHEMA_STATEMENTS = [
  'ALTER TABLE review_queue ADD COLUMN review_revision INTEGER NOT NULL DEFAULT 1',
] as const;

/**
 * 0043_price_backfill_termination.sql — negative-cache un-priceable tickers so
 * the backfill-market loop can reach done:true, and maintain an indexed
 * latest_price_date so price selection + freshness stop full-scanning price_eod.
 * Keep in exact lockstep with migrations/0043_price_backfill_termination.sql.
 */
export const PRICE_BACKFILL_TERMINATION_SCHEMA_STATEMENTS = [
  'ALTER TABLE securities_ref ADD COLUMN price_unavailable INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE securities_ref ADD COLUMN price_checked_at TEXT',
  'ALTER TABLE securities_ref ADD COLUMN latest_price_date TEXT',
  'CREATE INDEX IF NOT EXISTS idx_secref_latest_price_date ON securities_ref (latest_price_date)',
  `UPDATE securities_ref
   SET latest_price_date = (
     SELECT MAX(pe.date) FROM price_eod pe WHERE pe.ticker = securities_ref.ticker
   )
 WHERE latest_price_date IS NULL`,
  `UPDATE securities_ref
   SET current_price = (
         SELECT pe.close FROM price_eod pe
          WHERE pe.ticker = securities_ref.ticker
          ORDER BY pe.date DESC LIMIT 1
       ),
       current_price_date = (
         SELECT pe.date FROM price_eod pe
          WHERE pe.ticker = securities_ref.ticker
          ORDER BY pe.date DESC LIMIT 1
       )
 WHERE current_price IS NULL
   AND EXISTS (SELECT 1 FROM price_eod pe WHERE pe.ticker = securities_ref.ticker)`,
] as const;

/**
 * 0047_subscription_quota_active_only.sql — recreate trg_subscriptions_total_quota
 * so the 20-per-client lifetime cap only counts currently-active rows,
 * matching the corrected preflight in assertSubscriptionQuota
 * (src/delivery/subscriptions.ts). Fixes the "lifetime subscription lockout"
 * bug where deactivated rows permanently occupied a creation-quota slot with
 * no delete path to reclaim it. Keep in exact lockstep with
 * migrations/0047_subscription_quota_active_only.sql.
 */
export const SUBSCRIPTION_QUOTA_ACTIVE_ONLY_SCHEMA_STATEMENTS = [
  'DROP TRIGGER IF EXISTS trg_subscriptions_total_quota',
  `CREATE TRIGGER IF NOT EXISTS trg_subscriptions_total_quota
   BEFORE INSERT ON subscriptions
   WHEN (
     SELECT COUNT(*) FROM subscriptions
      WHERE client_id = NEW.client_id AND active = 1
   ) >= 20
   BEGIN
     SELECT RAISE(ABORT, 'subscription total quota exceeded');
   END`,
] as const;

/** Ordered review-queue autonomy schema mirrored by file migrations 0033-0037. */
export const REVIEW_AUTONOMY_SCHEMA_STATEMENTS = [
  ...REVIEW_COMPLEXITY_SCHEMA_STATEMENTS,
  ...REVIEW_AGREEMENT_SCHEMA_STATEMENTS,
  ...REVIEW_BUDGET_SCHEMA_STATEMENTS,
  ...REVIEW_RESOLUTION_SCHEMA_STATEMENTS,
  ...REVIEW_REVISION_SCHEMA_STATEMENTS,
] as const;

/**
 * 0044_tx_doc_index.sql — plain doc_id index on transactions so the correlated
 * `WHERE doc_id = ?` dedupe/selector subqueries (which the partial
 * row_key-gated composites cannot serve) stop full-scanning the table.
 * Keep in exact lockstep with migrations/0044_tx_doc_index.sql.
 */
export const TX_DOC_INDEX_SCHEMA_STATEMENTS = [
  'CREATE INDEX IF NOT EXISTS idx_tx_doc ON transactions (doc_id)',
] as const;

/** 0045_d1_budget.sql — atomic daily D1 row counters. */
export const D1_BUDGET_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS d1_budget (
     day          TEXT PRIMARY KEY,
     rows_read    INTEGER NOT NULL DEFAULT 0,
     rows_written INTEGER NOT NULL DEFAULT 0
   )`,
] as const;

/** 0046_usage_telemetry_probe_lease.sql — singleton half-open probe lease. */
export const USAGE_TELEMETRY_PROBE_LEASE_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS usage_telemetry_probe_lease (
     id          INTEGER PRIMARY KEY CHECK (id = 1),
     lease_token TEXT NOT NULL,
     expires_at  TEXT NOT NULL,
     updated_at  TEXT NOT NULL
   )`,
] as const;

/**
 * 0048_retention_indexes.sql — timestamp-leading indexes so the daily retention
 * sweep's `WHERE <ts> < ?` batch deletes range-scan by age instead of full-
 * scanning. `dead_letter_events` already has `idx_dead_letter_created`;
 * `ingest_log` and `source_attempts` only had `(source, <ts>)` composites whose
 * leading `source` column the age-only predicate cannot use.
 */
export const RETENTION_INDEX_SCHEMA_STATEMENTS = [
  'CREATE INDEX IF NOT EXISTS idx_ingest_log_polled_at ON ingest_log (polled_at)',
  'CREATE INDEX IF NOT EXISTS idx_source_attempts_attempted_at ON source_attempts (attempted_at)',
] as const;

/** 0049_autopilot.sql — backlog-autopilot run receipts + daily USD spend meter. */
export const AUTOPILOT_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS autopilot_runs (
     id                  TEXT PRIMARY KEY,
     status              TEXT NOT NULL DEFAULT 'running',
     run_trigger         TEXT NOT NULL,
     revision            INTEGER NOT NULL DEFAULT 1,
     backlog_before      INTEGER,
     docs_attempted      INTEGER NOT NULL DEFAULT 0,
     docs_published      INTEGER NOT NULL DEFAULT 0,
     docs_deferred       INTEGER NOT NULL DEFAULT 0,
     spend_microusd      INTEGER NOT NULL DEFAULT 0,
     budget_microusd     INTEGER NOT NULL DEFAULT 0,
     error_class_counts  TEXT,
     sample_errors       TEXT,
     outcomes            TEXT,
     skip_reasons        TEXT,
     halt_reason         TEXT,
     acknowledged_at     TEXT,
     acknowledged_by     TEXT,
     started_at          TEXT NOT NULL,
     updated_at          TEXT NOT NULL,
     finished_at         TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_autopilot_runs_status
     ON autopilot_runs (status, started_at DESC)`,
  `CREATE TABLE IF NOT EXISTS autopilot_budget (
     day            TEXT PRIMARY KEY,
     spend_microusd INTEGER NOT NULL DEFAULT 0
   )`,
] as const;

/** 0050_doc_class.sql — pre-extraction document classification. */
export const DOC_CLASS_SCHEMA_STATEMENTS = [
  'ALTER TABLE filings ADD COLUMN doc_class TEXT',
] as const;

/**
 * Ordered schema tail shared by POST /api/admin/migrate and migration parity
 * tests. Keep this in the same order as file migrations 0029 through 0050.
 */
export const POST_0024_SCHEMA_STATEMENTS = [
  // 0025_extraction_runs_usage.sql
  'ALTER TABLE extraction_runs ADD COLUMN usage_json TEXT',
  ...EST_VALUE_SCHEMA_STATEMENTS,
  ...RELIABILITY_SCHEMA_STATEMENTS,
  ...STRIPE_EVENT_SCHEMA_STATEMENTS,
  ...REVIEW_AUTONOMY_SCHEMA_STATEMENTS,
  ...BENCHMARK_SCHEMA_STATEMENTS,
  `CREATE TABLE IF NOT EXISTS batch_extractions_pending (
     doc_id        TEXT PRIMARY KEY,
     chamber       TEXT NOT NULL,
     enqueued_at   TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_batch_pending_enqueued ON batch_extractions_pending (enqueued_at)`,
  `CREATE TABLE IF NOT EXISTS usage_telemetry_fallback_events (
     idempotency_key TEXT PRIMARY KEY,
     event_json TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
     last_error TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_usage_telemetry_fallback_events_updated
     ON usage_telemetry_fallback_events (updated_at)`,
  // 0043_price_backfill_termination.sql
  ...PRICE_BACKFILL_TERMINATION_SCHEMA_STATEMENTS,
  // 0044_tx_doc_index.sql
  ...TX_DOC_INDEX_SCHEMA_STATEMENTS,
  // 0045_d1_budget.sql
  ...D1_BUDGET_SCHEMA_STATEMENTS,
  // 0046_usage_telemetry_probe_lease.sql
  ...USAGE_TELEMETRY_PROBE_LEASE_SCHEMA_STATEMENTS,
  // 0047_subscription_quota_active_only.sql
  ...SUBSCRIPTION_QUOTA_ACTIVE_ONLY_SCHEMA_STATEMENTS,
  // 0048_retention_indexes.sql
  ...RETENTION_INDEX_SCHEMA_STATEMENTS,
  // 0049_autopilot.sql
  ...AUTOPILOT_SCHEMA_STATEMENTS,
  // 0050_doc_class.sql
  ...DOC_CLASS_SCHEMA_STATEMENTS,
] as const;
