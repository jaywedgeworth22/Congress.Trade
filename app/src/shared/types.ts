/**
 * src/shared/types.ts
 *
 * Canonical shared contracts for congress-feed. Every module (ingestion,
 * extraction, delivery, admin) imports its types from here. Treat this file
 * as the source of truth — downstream agents implement against these shapes.
 */

import type { AssetTypeCategory } from './assetTypes';
import type {
  Chamber,
  Owner,
  TxType,
  ClientTrade,
} from '@jaywedgeworth22/congress-trading-shared';

/**
 * App-wide chamber union: `house | senate | executive`. As of shared package
 * v1.8.0, `executive` (OGE Form 278-T filers: President / Vice President) is
 * part of the upstream `congress-trading-shared` contract itself, so this is
 * now a plain re-export — no more app-local widening (see
 * docs/handoffs/2026-07-15-claude-to-monet.md for the migration). The
 * business rule is unchanged: executive rows are still EXCLUDED by default
 * from the feed/analytics (opt in via an explicit `chamber=` filter), from
 * webhook/SSE subscriptions without an explicit `chambers` filter, and from
 * the App-B bulk export surfaces — that filtering lives in application code,
 * not the type.
 */
export type { Chamber, Owner, TxType, ClientTrade };

// ---------------------------------------------------------------------------
// Primitive unions / enums
// ---------------------------------------------------------------------------


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

/** Transaction type: Purchase | Sale | Exchange. */

/** Delivery transport for a subscription. */
export type DeliveryChannel = 'webhook' | 'sse';

/** @deprecated alias of {@link DeliveryChannel}; kept for back-compat. */
export type DeliveryKind = DeliveryChannel;

/** Delivery attempt status. */
export type DeliveryStatus = 'pending' | 'delivered' | 'failed';

/** Provenance of a persisted transaction. 'manual' = hand-entered by an admin in
 *  review when the automated read was wrong / too low-confidence to trust. */
export type TxSource = 'primary' | 'seed_dataset' | 'manual';

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
  assetTypeName?: string | null;
  assetTypeCategory?: AssetTypeCategory;
  assetTypeCategoryLabel?: string;
  txType: TxType;
  amountMin: number | null;
  amountMax: number | null;
  isOption: boolean;
  capGainsOver200: boolean;
  rawText: string;
  filingStatus?: string | null;
  subholding?: string | null;
  location?: string | null;
  description?: string | null;
  supplementalText?: string | null;
  confidence: number;
  /** Provenance: live pipeline ('primary') vs backfill ('seed_dataset'). */
  source: TxSource;
  /**
   * Stable per-filing row identity used to make live normalization idempotent.
   * Historical rows may be null/absent until backfilled.
   */
  rowKey?: string | null;
  createdAt: string;
  /** Monotonic cursor for REST `?since=` paging. Assigned at insert. */
  cursorSeq: number;
  // --- Optional resolved filer identity (feed/stream only) -----------------
  // Populated only on the dashboard feed + SSE paths (LEFT JOIN filers); absent
  // on the webhook/normalizer paths, hence optional. null when unresolved.
  /** Filer's full name resolved from the filers table. */
  fullName?: string | null;
  /** Filer's state (e.g. 'CA') resolved from the filers table. */
  state?: string | null;
  /** Filer's headshot URL (unitedstates/images CDN); null = show initials. */
  photoUrl?: string | null;
  /** Filing's official disclosure date (date-only) from the source. Feed only. */
  filedDate?: string | null;
  /** When our watcher first saw the filing (timestamp). Feed only. */
  firstSeenAt?: string | null;
  /** Original public disclosure document URL. Feed only. */
  sourceUrl?: string | null;
  // --- Optional cross-referenced asset data (securities_ref; feed only) ------
  // Populated when the ticker has been enriched; null/absent otherwise.
  refCompanyName?: string | null;
  refSector?: string | null;
  refMarketCap?: number | null;
  refMarketCapBucket?: string | null;
  refCountry?: string | null;
  refExchangeShort?: string | null;
  refAssetClass?: string | null;
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
  assetTypeName?: string | null;
  txType: TxType;
  amountMin: number | null;
  amountMax: number | null;
  isOption: boolean;
  capGainsOver200: boolean;
  /**
   * Source fields that were explicitly unreadable and were defaulted locally,
   * or provenance markers for the row itself (e.g. recovered from a truncated
   * provider response — see `salvageTruncatedTransactions` in visionLlm.ts).
   */
  extractionWarnings?: Array<'unreadable_is_option' | 'unreadable_cap_gains' | 'salvaged_truncated_output'>;
  /** Verbatim source text for this row, for audit/review. */
  rawText: string;
  /** Structured/detail text that belongs to this filing row, not page chrome. */
  filingStatus?: string | null;
  subholding?: string | null;
  location?: string | null;
  description?: string | null;
  supplementalText?: string | null;
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
  /** Minimum transaction amount_min (bracket floor) to deliver. */
  minAmount?: number;
  /** Maximum transaction amount_min (bracket floor); pairs with minAmount for a range. */
  maxAmount?: number;
  /** Transaction sides to include, e.g. ['P'] for buys only (empty/undefined => all). */
  sides?: TxType[];
  /** GICS sectors to include (securities_ref.sector); empty/undefined => all. */
  sectors?: string[];
  /** Market-cap buckets to include (mega…nano, securities_ref.market_cap_bucket). */
  marketCapBuckets?: string[];
}

export interface Subscription {
  id: string;
  clientId: string;
  delivery: DeliveryChannel;
  /** Webhook target URL; null/empty for sse subscriptions. */
  targetUrl: string | null;
  /** Per-subscription credential: webhook HMAC key and SSE/management bearer secret. */
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
  /** Monotonic optimistic-concurrency version for review-visible state. */
  reviewRevision: number;
  sourceUrl?: string;
  rawObjectKey?: string;
  docKind?: string;
}

// ---------------------------------------------------------------------------
// Client API contracts (shared PWA + SwiftUI backend surface)
// ---------------------------------------------------------------------------


export interface ClientPreferences {
  userId: string;
  savedFilters: Record<string, unknown>;
  watchlist: string[];
  notificationSettings: Record<string, unknown>;
  defaultWindow: string | null;
  updatedAt: string;
}

export type ClientCommandType =
  | 'update_preferences'
  | 'create_subscription'
  | 'update_subscription'
  | 'start_checkout'
  | 'request_export';

export type ClientCommandStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

export interface ClientCommand {
  id: string;
  userId: string;
  type: ClientCommandType;
  status: ClientCommandStatus;
  idempotencyKey: string | null;
  payload: unknown;
  result: unknown | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

// ---------------------------------------------------------------------------
// End-user accounts (public-site auth: Google OAuth + email magic-link)
// ---------------------------------------------------------------------------

/**
 * A public-site end user. Distinct from the admin surface and from delivery
 * `Subscription`s (webhook/SSE targets). Billing fields (Stripe) were layered on
 * in migration 0004 and are null until the user starts a checkout.
 */
export interface User {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
  /** Google `sub` claim when the user has linked Google sign-in; null otherwise. */
  googleSub: string | null;
  emailVerified: boolean;
  createdAt: string;
  lastLoginAt: string | null;

  // --- Billing (Stripe). Null until the user starts a checkout. ---
  /** Stripe customer id (`cus_…`), created lazily on first checkout. */
  stripeCustomerId: string | null;
  /** Stripe subscription id (`sub_…`) for the active/most-recent subscription. */
  stripeSubscriptionId: string | null;
  /** Raw Stripe subscription status: trialing | active | past_due | canceled | … */
  subscriptionStatus: string | null;
  /** Billing cadence of the current subscription. */
  plan: BillingPlan | null;
  /** ISO end of the current billing period (access end on cancel). */
  currentPeriodEnd: string | null;
  /** True when the subscription is set to cancel at period end. */
  cancelAtPeriodEnd: boolean;
  /** ISO end of the free trial, when trialing. */
  trialEnd: string | null;
}

/** Subscription billing cadence. */
export type BillingPlan = 'monthly' | 'annual';

/**
 * Resolved access level for a user (or anonymous visitor). Derived purely from
 * the user's billing fields by billing/entitlement.ts — never stored.
 */
export interface Entitlement {
  /** True when the visitor may access premium features (full history, export). */
  premium: boolean;
  /** Raw Stripe status, or null for anonymous / never-subscribed users. */
  status: string | null;
  plan: BillingPlan | null;
  /** True while in the free trial window. */
  trialing: boolean;
  trialEnd: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
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
  | {
      type: 'agreement.check';
      docId: string;
      rawObjectKey: string | null;
      escalationTier?: number;
      /** Durable review_queue lease owner; optional for pre-0031 queued messages. */
      claimToken?: string;
    }
  | {
      type: 'delivery.dispatch';
      txId: string;
      /** Legacy targeted dispatch retained for already-enqueued messages. */
      subscriptionId?: string;
      /** Keyset cursor for one-page-per-message webhook fanout. */
      afterSubscriptionId?: string;
    }
  | {
      /** Durable hand-off for one secret-safe external API usage event. */
      type: 'usage.telemetry';
      event: ThirdPartyUsageTelemetryEvent;
    };

/**
 * Wire shape accepted by usage.jays.services. Keep this deliberately free of
 * request URLs, headers, query strings, bodies, and response payloads.
 */
export interface ThirdPartyUsageTelemetryEvent {
  idempotencyKey: string;
  sourceApp: 'congress-trade';
  environment: string;
  provider: string;
  service: string;
  project: 'congress-trade';
  label: string;
  keyRef: string;
  billingMode: 'actual' | 'estimated' | 'manual';
  metricType: 'usage' | 'cost' | 'limit';
  quantity?: number;
  unit?: 'request' | 'call' | 'token' | 'credit' | 'usd' | 'page' | 'job' | 'document' | 'row' | 'byte';
  costUsd?: number;
  requests?: number;
  credits?: number;
  confidence: 'actual' | 'estimated' | 'manual';
  occurredAt: string;
  metadata?: Record<string, string | number | boolean | null>;
}

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
  GEMINI_RPM_LIMIT?: string;
  /** Primary vision model override (defaults to 'gemini-3.5-flash'). */
  VISION_PRIMARY_MODEL?: string;
  /** Secondary arbitration extractor key. Presence enables arbitration. */
  ARBITRATION_API_KEY?: string;
  /** Anthropic API key — Claude vision candidates in the extractor bake-off. */
  ANTHROPIC_API_KEY?: string;
  /** Anthropic model override (defaults to 'claude-sonnet-5'). */
  ANTHROPIC_MODEL?: string;
  /** OpenAI API key — GPT vision candidates in the extractor bake-off. */
  OPENAI_API_KEY?: string;
  /** Mistral API key — `mistral-ocr-latest` candidate in the extractor bake-off. */
  MISTRAL_API_KEY?: string;
  /** xAI API key — Grok (Files API → grok-4.3) candidate in the extractor bake-off. */
  XAI_API_KEY?: string;
  /** OpenRouter API key — for arbitrary open-weights vision model candidates. */
  OPENROUTER_API_KEY?: string;
  /** OpenRouter model override (defaults to 'qwen/qwen-2.5-vl-72b-instruct:free'). */
  OPENROUTER_MODEL?: string;
  /** LlamaIndex Cloud API key — LlamaParse OCR + structured extraction candidate. */
  /** Additional market/enrichment provider keys. */
  MASSIVE_API_KEY?: string;
  INTRINIO_API_KEY?: string;
  TWELVEDATA_API_KEY?: string;
  FINNHUB_API_KEY?: string;
  /** Tiingo API key — enrichment fallback + optional price-history fallback. */
  TIINGO_API_KEY?: string;
  /** Logo.dev public token for the ticker-logo proxy. */
  LOGODEV_PUBLISHABLE_KEY?: string;
  /** 'true' enables the per-minute autonomous cross-vendor agreement → auto-publish pass. */
  AGREEMENT_AUTOPUBLISH_ENABLED?: string;
  /** Max review docs the autonomous pass attempts per cron tick (default 3). */
  AGREEMENT_AUTOPUBLISH_LIMIT?: string;
  /** Max cascade attempts (tier passes) per review doc before it stays in human review (default 3). */
  AGREEMENT_MAX_ATTEMPTS?: string;
  /** Daily autonomous candidate-doc-read budget; -1 explicitly disables the cap (default 300). */
  AGREEMENT_DAILY_LLM_BUDGET?: string;
  /**
   * When 'true' (default), a doc whose cheap complexity signals exceed the
   * thresholds (page_count / raw_bytes) starts the cascade directly at tier 2
   * (three models) instead of tier 1. Set 'false' to always start at tier 1.
   */
  AGREEMENT_BIG_DOC_START_TIER2?: string;
  /** Page-count threshold for the big-doc tier-2 start heuristic (default 10). */
  AGREEMENT_BIG_DOC_PAGE_THRESHOLD?: string;
  /** Raw-byte threshold for the big-doc tier-2 start heuristic (default 2097152 = 2MB). */
  AGREEMENT_BIG_DOC_BYTES_THRESHOLD?: string;
  /** Financial Modeling Prep key — enables asset enrichment + price/performance. */
  FMP_API_KEY?: string;
  /** Daily FMP call budget (stringified int); defaults to 230 when unset. */
  FMP_DAILY_CALL_CAP?: string;
  /** Shared FMP per-minute pacer ceiling (stringified int). Infisical-tunable. */
  FMP_MAX_PER_MINUTE?: string;
  /** SEC EDGAR per-minute pacer ceiling (stringified int). Infisical-tunable. */
  EDGAR_MAX_PER_MINUTE?: string;
  /** Local-dev-only escape hatch: opens admin when the environment is not production. */
  ADMIN_OPEN_IN_DEV?: string;
  /** Override URLs for the seed backfill datasets (House / Senate mirrors). */
  SEED_HOUSE_URL?: string;
  SEED_SENATE_URL?: string;
  /** House live search polling flag; fail-soft (on unless explicitly "false"). */
  HOUSE_LIVE_SEARCH_ENABLED?: string;
  /** Days into January during which the prior-year House index is also swept
   *  (year-boundary gap; default 14, 0 disables). Infisical-tunable. */
  HOUSE_PRIOR_YEAR_OVERLAP_DAYS?: string;
  /** Base Senate submitted-date lookback in days (default 7). Infisical-tunable. */
  SENATE_LOOKBACK_DAYS?: string;
  /** Widened Senate lookback (days) used for the daily deep sweep and outage
   *  catch-up (default 30; raise temporarily for one-off deep recovery). */
  SENATE_MAX_LOOKBACK_DAYS?: string;
  /** Enables the OGE executive-branch (278-T) filings watcher. Infisical-tunable. */
  OGE_WATCH_ENABLED?: string;
  /** Override URL for the OGE President/VP filings index view. */
  OGE_INDEX_URL?: string;
  /** Minimum seconds between OGE index polls (default 21600 = 6h). */
  OGE_POLL_INTERVAL_SEC?: string;
  /** Max raw PDF bytes sent to vision extraction for executive filings (default 6MB). */
  OGE_MAX_VISION_BYTES?: string;
  /** Model override for the secondary (arbitration) vision extractor. */
  ARBITRATION_MODEL?: string;
  /** Enables the Congress.Trade-vs-provider congressional disclosure latency monitor. */
  DISCLOSURE_LATENCY_WATCH_ENABLED?: string;
  /** Enables the public-API anti-scraping guard (UA blocklist + per-IP budgets). Unset = off. */
  SCRAPE_GUARD_ENABLED?: string;
  /** App-level D1 daily rows-READ budget (stringified int). Soft-warns at 80%; default 200M/day. Infisical-tunable. */
  D1_DAILY_ROWS_READ_BUDGET?: string;
  /** App-level D1 daily rows-WRITTEN budget (stringified int). Soft-warns at 80%; default 2M/day (~$10/mo of D1 writes). Infisical-tunable. */
  D1_DAILY_ROWS_WRITTEN_BUDGET?: string;
  /** Arm the D1 row-budget HARD stop (skip discretionary daily jobs when over budget). Unset = off (alert-only). Infisical-tunable. */
  D1_ROW_BUDGET_ENFORCE?: string;
  /** Comma-separated provider ids to race: fmp, unusual_whales, quiver. Defaults to direct comparable providers. */
  DISCLOSURE_LATENCY_PROVIDERS?: string;
  /** Latest rows to fetch per provider/chamber endpoint when the latency monitor runs. */
  DISCLOSURE_LATENCY_WATCH_LIMIT?: string;
  /** Enables the legacy Congress.Trade-vs-FMP monitor switch; kept for backward compatibility. */
  FMP_DISCLOSURE_WATCH_ENABLED?: string;
  /** Legacy FMP-specific latest-row limit; DISCLOSURE_LATENCY_WATCH_LIMIT takes precedence. */
  FMP_DISCLOSURE_WATCH_LIMIT?: string;
  /** Unusual Whales API key for recent Congress trades. */
  UNUSUAL_WHALES_API_KEY?: string;
  /** Distinct filed dates the UW disclosure-latency deep-match pass may query
   *  per probe run (recent-trades?date=<filedDate>), for pending observations
   *  older than the normal ~200-row window. Default 8; clamped to [0, 25];
   *  0 disables the pass. */
  UW_DEEP_MATCH_DATES_PER_RUN?: string;
  /** Quiver API bearer token for live Congress trading endpoints. */
  QUIVER_API_KEY?: string;
  QUIVER_API_TOKEN?: string;
  /** AInvest key; currently reported as symbol-scoped and not directly comparable for this monitor. */
  AINVEST_API_KEY?: string;
  /** Which price provider to prefer: 'fmp' or 'massive'. */
  PRICE_PROVIDER?: string;
  /** HMAC key for signing outbound webhook payloads. */
  WEBHOOK_SIGNING_KEY?: string;
  /** Sentry DSN for error monitoring (Cloudflare Workers SDK). */
  SENTRY_DSN?: string;
  /** Sentry event/log environment tag, e.g. "production" | "preview". */
  SENTRY_ENVIRONMENT?: string;
  /** Read-only safety switch for isolated branch-review deployments. */
  PREVIEW_DEPLOYMENT?: string;
  /** Uniform trace sampling rate (0-1) for the Sentry Cloudflare SDK; overrides the code default. */
  SENTRY_TRACES_SAMPLE_RATE?: string;
  /** Cloudflare Workers version metadata binding; used by Sentry to auto-tag the release. */
  CF_VERSION_METADATA?: { id: string; tag: string; timestamp?: string };

  // --- End-user auth (public-site sign-in) ---
  /** Google OAuth client credentials for "Sign in with Google". */
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  /** Resend API key + verified from-address for magic-link sign-in emails. */
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  /** Recipient for operational alert emails (e.g. FMP tier failures); reuses RESEND_API_KEY + EMAIL_FROM. */
  ALERT_EMAIL?: string;
  /** Public base URL (e.g. https://congress.trade) for OAuth redirects + links. */
  APP_BASE_URL?: string;
  /** Cross-app share endpoint + token for pushing refreshed market refs/prices. */
  APP_B_IMPORT_URL?: string;
  APP_B_INGEST_TOKEN?: string;
  /** API Usage Monitor scoped ingest endpoint for app-provider usage telemetry. */
  USAGE_MONITOR_ENABLED?: string;
  USAGE_MONITOR_INGEST_URL?: string;
  USAGE_MONITOR_INGEST_TOKEN?: string;
  USAGE_MONITOR_ENVIRONMENT?: string;
  /**
   * Usage telemetry delivery circuit breaker + R2 outbox limits (see
   * shared/thirdPartyTelemetry.ts). All are env-overridable; every one has a
   * safe built-in default and none require a redeploy to tune during an
   * incident. Added after a receiver outage let unbounded retries churn a
   * growing D1 table into a large overage — see docs/rollouts for the record.
   */
  /** Consecutive delivery failures before the circuit opens (default 3). */
  USAGE_TELEMETRY_CIRCUIT_FAILURE_THRESHOLD?: string;
  /** First open-circuit backoff window in ms; doubles per repeated probe failure (default 30000 = 30s). */
  USAGE_TELEMETRY_CIRCUIT_BASE_BACKOFF_MS?: string;
  /** Cap on the exponential backoff window in ms (default 1800000 = 30min). */
  USAGE_TELEMETRY_CIRCUIT_MAX_BACKOFF_MS?: string;
  /** Receiver request deadline in ms (default 15000, hard cap 60000). */
  USAGE_TELEMETRY_DELIVERY_TIMEOUT_MS?: string;
  /** Atomic half-open probe lease in ms; always exceeds the delivery deadline (default 30000). */
  USAGE_TELEMETRY_CIRCUIT_PROBE_LEASE_MS?: string;
  /** Hard cap on pending R2 outbox objects; new events are dropped past this (default 5000). */
  USAGE_TELEMETRY_FALLBACK_MAX_OBJECTS?: string;
  /** Age in days at which a pending R2 outbox object is discarded unsent (default 14). */
  USAGE_TELEMETRY_FALLBACK_TTL_DAYS?: string;
  /** Max legacy D1 fallback rows read per flush cycle during the one-time drain (default 100, hard cap 500). */
  USAGE_TELEMETRY_D1_DRAIN_LIMIT?: string;
  /** Admin + scoped import bearer tokens. */
  ADMIN_TOKEN?: string;
  /** Admin email allowlist for site-session admin access and Cloudflare Access. */
  ADMIN_EMAILS?: string;
  /** Cloudflare Access team name/hostname for admin API JWT verification. */
  ACCESS_TEAM_DOMAIN?: string;
  /** Cloudflare Access application AUD tag for admin API JWT verification. */
  ACCESS_AUD?: string;
  INGEST_TOKEN?: string;
  /** Scoped token for the idempotent admin maintenance endpoints only (backlog requeue/retry). */
  ADMIN_MAINTENANCE_TOKEN?: string;
  LLAMAPARSE_API_KEY?: string;

  // --- Billing (Stripe) ---
  /** Stripe secret key (`sk_…`) for the REST API. Presence enables billing. */
  STRIPE_SECRET_KEY?: string;
  /** Stripe webhook signing secret (`whsec_…`) for verifying webhook events. */
  STRIPE_WEBHOOK_SECRET?: string;
  /** Stripe Price ids for the premium tier (one per cadence). */
  STRIPE_PRICE_MONTHLY?: string;
  STRIPE_PRICE_ANNUAL?: string;
  /** Free-trial length in days for new subscriptions (default 7). */
  STRIPE_TRIAL_DAYS?: string;
  /** "true" to enable Stripe Managed Payments (merchant-of-record) on Checkout.
   *  Leave off until the account is approved for Managed Payments and products
   *  carry an eligible digital tax code. */
  STRIPE_MANAGED_PAYMENTS?: string;

  // --- Infisical runtime secret resolver ---
  /** Optional Infisical API origin. Defaults to https://app.infisical.com. */
  INFISICAL_BASE_URL?: string;
  /** Infisical environment/slug for both app + shared projects. Defaults to prod. */
  INFISICAL_ENV?: string;
  /** Short-lived in-isolate secret cache TTL. Defaults to 600 seconds. */
  INFISICAL_CACHE_TTL_SECONDS?: string;
  /** Set "false" after cutover to disable fallback to Cloudflare Worker secrets. */
  INFISICAL_ALLOW_ENV_FALLBACK?: string;
  /** App-specific Infisical machine identity + project. */
  INFISICAL_APP_PROJECT_ID?: string;
  INFISICAL_APP_CLIENT_ID?: string;
  INFISICAL_APP_CLIENT_SECRET?: string;
  INFISICAL_APP_SECRET_PATH?: string;
  /** Shared Infisical machine identity + project for shared-at-ct secrets. */
  INFISICAL_SHARED_PROJECT_ID?: string;
  INFISICAL_SHARED_CLIENT_ID?: string;
  INFISICAL_SHARED_CLIENT_SECRET?: string;
  INFISICAL_SHARED_SECRET_PATH?: string;

  // --- Plain vars (.dev.vars / [vars]) ---
  /** "true" to force arbitration on when configured. */
  ARBITRATION_ENABLED?: string;
  /** Cross-app import guardrails. Tune down for lean/free-compatible runs. */
  IMPORT_MAX_BYTES?: string;
  IMPORT_MAX_REFS?: string;
  IMPORT_MAX_SPX?: string;
  IMPORT_MAX_PRICES?: string;
  IMPORT_MAX_CLOSES_PER_TICKER?: string;
  IMPORT_MAX_INSIDER?: string;
  IMPORT_MAX_SHORT_VOLUME?: string;
}
