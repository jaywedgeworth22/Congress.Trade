/**
 * src/shared/types.ts
 *
 * Canonical shared contracts for congress-feed. Every module (ingestion,
 * extraction, delivery, admin) imports its types from here. Treat this file
 * as the source of truth — downstream agents implement against these shapes.
 */

import type { AssetTypeCategory } from './assetTypes';

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
  sourceUrl?: string;
  rawObjectKey?: string;
  docKind?: string;
}

// ---------------------------------------------------------------------------
// Client API contracts (shared PWA + SwiftUI backend surface)
// ---------------------------------------------------------------------------

export interface ClientTrade {
  id: string;
  cursor: number;
  docId: string;
  member: {
    id: string | null;
    name: string | null;
    chamber: Chamber | null;
    party: string | null;
    state: string | null;
    photoUrl: string | null;
  };
  asset: {
    name: string;
    ticker: string | null;
    /** Canonical company name from securities_ref (null until the ticker is enriched). */
    companyName: string | null;
    /** Same-origin cached logo proxy URL for the ticker, or null when no ticker is resolved. */
    logoUrl: string | null;
    /** Raw disclosure asset type/code as stored in transactions.asset_type. */
    type: string | null;
    /** Expanded raw type name when available, e.g. House code label. */
    typeName: string | null;
    /** Cross-chamber canonical instrument category, computed from raw type/code. */
    typeCategory: AssetTypeCategory;
    /** Human label for typeCategory. */
    typeCategoryLabel: string;
    sector: string | null;
    marketCapBucket: string | null;
  };
  transaction: {
    date: string | null;
    type: TxType;
    owner: Owner | null;
    amountMin: number | null;
    amountMax: number | null;
    isOption: boolean;
  };
  filing: {
    filedDate: string | null;
    firstSeenAt: string | null;
    sourceUrl: string | null;
  };
  confidence: number;
  source: TxSource;
}

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
  | { type: 'agreement.check'; docId: string; rawObjectKey: string | null }
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
  /** Anthropic API key — Claude vision candidates in the extractor bake-off. */
  ANTHROPIC_API_KEY?: string;
  /** OpenAI API key — GPT vision candidates in the extractor bake-off. */
  OPENAI_API_KEY?: string;
  /** Mistral API key — `mistral-ocr-latest` candidate in the extractor bake-off. */
  MISTRAL_API_KEY?: string;
  /** xAI API key — Grok (Files API → grok-4.3) candidate in the extractor bake-off. */
  XAI_API_KEY?: string;
  /** LlamaIndex Cloud API key — LlamaParse OCR + structured extraction candidate. */
  LLAMAINDEX_API_KEY?: string;
  /** Additional market/enrichment provider keys. */
  MASSIVE_API_KEY?: string;
  INTRINIO_API_KEY?: string;
  TWELVEDATA_API_KEY?: string;
  FINNHUB_API_KEY?: string;
  /** Logo.dev public token for the ticker-logo proxy. */
  LOGODEV_PUBLISHABLE_KEY?: string;
  /** 'true' enables the per-minute autonomous cross-vendor agreement → auto-publish pass. */
  AGREEMENT_AUTOPUBLISH_ENABLED?: string;
  /** Agreement model A as "provider:model" (default mistral:mistral-ocr-latest). */
  AGREEMENT_AUTOPUBLISH_MODEL_A?: string;
  /** Agreement model B as "provider:model" (default gemini:gemini-3.5-flash). */
  AGREEMENT_AUTOPUBLISH_MODEL_B?: string;
  /** Max review docs the autonomous pass attempts per cron tick (default 3). */
  AGREEMENT_AUTOPUBLISH_LIMIT?: string;
  /** Financial Modeling Prep key — enables asset enrichment + price/performance. */
  FMP_API_KEY?: string;
  /** Daily FMP call budget (stringified int); defaults to 230 when unset. */
  FMP_DAILY_CALL_CAP?: string;
  /** Enables the Congress.Trade-vs-provider congressional disclosure latency monitor. */
  DISCLOSURE_LATENCY_WATCH_ENABLED?: string;
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
  /** Admin + scoped import bearer tokens. */
  ADMIN_TOKEN?: string;
  /** Admin email allowlist for site-session admin access and Cloudflare Access. */
  ADMIN_EMAILS?: string;
  /** Cloudflare Access team name/hostname for admin API JWT verification. */
  ACCESS_TEAM_DOMAIN?: string;
  /** Cloudflare Access application AUD tag for admin API JWT verification. */
  ACCESS_AUD?: string;
  INGEST_TOKEN?: string;
  /** LlamaParse legacy key name; LLAMAINDEX_API_KEY remains the runtime key used by extraction. */
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
