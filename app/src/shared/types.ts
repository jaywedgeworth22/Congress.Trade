/**
 * src/shared/types.ts
 *
 * Canonical shared contracts for congress-feed. Every module (ingestion,
 * extraction, delivery, admin) imports its types from here. Treat this file
 * as the source of truth — downstream agents implement against these shapes.
 */

// ---------------------------------------------------------------------------
// Primitive unions / enums
// ---------------------------------------------------------------------------

export type Chamber = 'house' | 'senate';

/**
 * Filing type code. STOCK Act Periodic Transaction Reports are 'P'.
 * Kept as a broad string-union to allow future filing types without a
 * breaking change to consumers.
 */
export type FilingType = 'P' | (string & {});

/** Pipeline status of a single filing as it moves through ingestion. */
export type IngestStatus =
  | 'new'
  | 'fetched'
  | 'classified'
  | 'extracted'
  | 'persisted'
  | 'needs_review'
  | 'error';

/** Detected physical form of a disclosure document. */
export type DocKind = 'senate_html' | 'text_pdf' | 'scanned_pdf' | 'unknown';

/** Beneficial owner of a transaction. */
export type Owner = 'self' | 'spouse' | 'joint' | 'dependent';

/** Transaction type: Purchase | Sale | Exchange. */
export type TxType = 'P' | 'S' | 'E';

/** Delivery transport for a subscription. */
export type DeliveryChannel = 'webhook' | 'sse';

/** @deprecated alias of {@link DeliveryChannel}; kept for back-compat. */
export type DeliveryKind = DeliveryChannel;

/** Delivery attempt status. */
export type DeliveryStatus = 'pending' | 'delivered' | 'failed';

/** Provenance of a persisted transaction. */
export type TxSource = 'primary' | 'seed_dataset';

// ---------------------------------------------------------------------------
// Domain entities (mirror D1 tables; JSON columns are typed as parsed shapes)
// ---------------------------------------------------------------------------

export interface Filer {
  bioguideId: string;
  chamber: Chamber;
  fullName: string;
  party: string;
  state: string;
  district: string;
  /** Committee identifiers/names (stored as JSON in D1). */
  committees: string[];
}

export interface Filing {
  docId: string;
  chamber: Chamber;
  filerId: string | null;
  filingType: FilingType;
  filedDate: string | null;
  sourceUrl: string;
  /** R2 object key of the raw fetched original (null until fetched). */
  rawObjectKey: string | null;
  ingestStatus: IngestStatus;
  docKind: DocKind;
  /** Name of the extractor that produced the result (null until extracted). */
  extractor: string | null;
  modelVersion: string | null;
  confidence: number | null;
  firstSeenAt: string;
  sourceUpdatedAt: string | null;
  error: string | null;
}

export interface Transaction {
  id: string;
  docId: string;
  filerId: string | null;
  txDate: string | null;
  owner: Owner | null;
  assetName: string;
  ticker: string | null;
  assetType: string | null;
  txType: TxType;
  amountMin: number | null;
  amountMax: number | null;
  isOption: boolean;
  capGainsOver200: boolean;
  rawText: string;
  confidence: number;
  /** Provenance: live pipeline ('primary') vs backfill ('seed_dataset'). */
  source: TxSource;
  createdAt: string;
  /** Monotonic cursor for REST `?since=` paging. Assigned at insert. */
  cursorSeq: number;
}

/**
 * A transaction as produced by an extractor, BEFORE normalization/persistence.
 * Ticker may be unresolved; amount bracket may not yet be validated. The
 * normalizer (src/extraction/normalizer.ts) turns ParsedTx[] into Transaction[].
 */
export interface ParsedTx {
  txDate: string | null;
  owner: Owner | null;
  assetName: string;
  /** Raw ticker as seen in the document; may be null/garbage pre-resolution. */
  ticker: string | null;
  assetType: string | null;
  txType: TxType;
  amountMin: number | null;
  amountMax: number | null;
  isOption: boolean;
  capGainsOver200: boolean;
  /** Verbatim source text for this row, for audit/review. */
  rawText: string;
  /** Per-row extractor confidence in [0,1]. */
  confidence: number;
}

export interface SubscriptionFilters {
  /** Filer bioguide ids to include (empty/undefined => all). */
  members?: string[];
  /** Tickers to include (empty/undefined => all). */
  tickers?: string[];
  /** Chambers to include (empty/undefined => all). */
  chambers?: Chamber[];
  /** Minimum transaction amount_min to deliver. */
  minAmount?: number;
}

export interface Subscription {
  id: string;
  clientId: string;
  delivery: DeliveryChannel;
  /** Webhook target URL; null/empty for sse subscriptions. */
  targetUrl: string | null;
  /** Per-subscription HMAC secret (webhook signing). */
  secret: string | null;
  filters: SubscriptionFilters;
  /** Last delivered transactions.cursorSeq. */
  cursor: number;
  active: boolean;
  createdAt: string;
}

export interface Delivery {
  id: string;
  subscriptionId: string;
  txId: string;
  status: DeliveryStatus;
  attempts: number;
  lastError: string | null;
  updatedAt: string;
}

export interface ReviewItem {
  docId: string;
  reason: string;
  /** Arbitrary JSON payload describing the low-confidence parse. */
  payload: unknown;
  createdAt: string;
  resolved: boolean;
}

// ---------------------------------------------------------------------------
// Poll configuration (adaptive scheduling)
// ---------------------------------------------------------------------------

/**
 * A single window of the adaptive poll schedule. Hours are in America/New_York
 * (Eastern) local time. A window matches when the current ET weekday is in
 * daysOfWeek AND startHourET <= hourET < endHourET. endHourET of 24 means
 * "through end of day".
 */
export interface PollWindow {
  /** 0=Sunday ... 6=Saturday. */
  daysOfWeek: number[];
  startHourET: number;
  endHourET: number;
  intervalSec: number;
}

export interface PollConfig {
  schedule: PollWindow[];
  aggressiveMode: boolean;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Queue messages (stage hand-off + delivery fan-out)
// ---------------------------------------------------------------------------

export type QueueMessage =
  | { type: 'filing.new'; docId: string; chamber: Chamber; sourceUrl: string }
  | { type: 'filing.fetched'; docId: string }
  | { type: 'filing.extracted'; docId: string }
  | { type: 'tx.persisted'; txId: string; docId: string }
  | { type: 'delivery.dispatch'; txId: string };

// ---------------------------------------------------------------------------
// Worker environment bindings + secrets
// ---------------------------------------------------------------------------

export interface Env {
  // --- Bindings (wrangler.toml) ---
  DB: D1Database;
  RAW_FILES: R2Bucket;
  INGEST_QUEUE: Queue<QueueMessage>;
  DELIVERY_QUEUE: Queue<QueueMessage>;
  CONFIG_KV: KVNamespace;

  // --- Secrets (wrangler secret put / .dev.vars) ---
  /** Vision/text LLM key (e.g. Gemini) for scanned-PDF extraction. */
  GEMINI_API_KEY?: string;
  /** Secondary arbitration extractor key. Presence enables arbitration. */
  ARBITRATION_API_KEY?: string;
  /** HMAC key for signing outbound webhook payloads. */
  WEBHOOK_SIGNING_KEY?: string;

  // --- Plain vars (.dev.vars / [vars]) ---
  /** "true" to force arbitration on when configured. */
  ARBITRATION_ENABLED?: string;
}
