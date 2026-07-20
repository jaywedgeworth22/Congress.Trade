"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  API_PATHS: () => API_PATHS,
  API_USAGE_MONITOR_INGEST_PATH: () => API_USAGE_MONITOR_INGEST_PATH,
  APP_B_ORIGIN: () => APP_B_ORIGIN_TAG,
  APP_B_ORIGIN_TAG: () => APP_B_ORIGIN_TAG,
  AmountBracketSchema: () => AmountBracketSchema,
  AnalystRowSchema: () => AnalystRowSchema,
  AssetTypeCategorySchema: () => AssetTypeCategorySchema,
  BacktestHorizonSchema: () => BacktestHorizonSchema,
  BundleResponseSchema: () => BundleResponseSchema,
  CONGRESS_EVENT_TYPES: () => CONGRESS_EVENT_TYPES,
  CallClassifierContextSchema: () => CallClassifierContextSchema,
  ChamberSchema: () => ChamberSchema,
  ClientAssetSchema: () => ClientAssetSchema,
  ClientFilingSchema: () => ClientFilingSchema,
  ClientMemberSchema: () => ClientMemberSchema,
  ClientTradeSchema: () => ClientTradeSchema,
  ClientTransactionSchema: () => ClientTransactionSchema,
  ClusterBuySchema: () => ClusterBuySchema,
  CommitteeConflictSchema: () => CommitteeConflictSchema,
  CongressEventSchema: () => CongressEventSchema,
  CongressEventTypeSchema: () => CongressEventTypeSchema,
  CongressTradeClient: () => CongressTradeClient,
  CongressTradeHttpError: () => CongressTradeHttpError,
  CongressTransactionReadSchema: () => CongressTransactionReadSchema,
  CongressTransactionSchema: () => CongressTransactionSchema,
  ConvictionTickerSchema: () => ConvictionTickerSchema,
  DEFAULT_CONGRESS_TRADE_BASE_URL: () => DEFAULT_CONGRESS_TRADE_BASE_URL,
  DEFAULT_TRANSACTIONS_LIMIT: () => DEFAULT_TRANSACTIONS_LIMIT,
  FundamentalRowSchema: () => FundamentalRowSchema,
  InsiderReadRowSchema: () => InsiderReadRowSchema,
  InsiderRowSchema: () => InsiderRowSchema,
  IsoDateSchema: () => IsoDateSchema,
  LAG_BUCKETS: () => LAG_BUCKETS,
  MAX_REFS_BATCH: () => MAX_REFS_BATCH,
  MKT_CAP_THRESHOLDS: () => MKT_CAP_THRESHOLDS,
  MemberLeaderSchema: () => MemberLeaderSchema,
  MemberPerformanceSchema: () => MemberPerformanceSchema,
  MktCapBucketSchema: () => MktCapBucketSchema,
  OperationGuardInFlightSchema: () => OperationGuardInFlightSchema,
  OperationGuardRateLimitedSchema: () => OperationGuardRateLimitedSchema,
  OperationGuardRejectionSchema: () => OperationGuardRejectionSchema,
  OwnerSchema: () => OwnerSchema,
  PartyBucketSchema: () => PartyBucketSchema,
  PriceCloseSchema: () => PriceCloseSchema,
  PriceSeriesSchema: () => PriceSeriesSchema,
  STOCK_ACT_BRACKETS: () => STOCK_ACT_BRACKETS,
  SecurityRefInputSchema: () => SecurityRefInputSchema,
  SecurityRefSchema: () => SecurityRefSchema,
  SharePayloadSchema: () => SharePayloadSchema,
  ShortVolumeReadRowSchema: () => ShortVolumeReadRowSchema,
  ShortVolumeRowSchema: () => ShortVolumeRowSchema,
  SnapshotManifestSchema: () => SnapshotManifestSchema,
  SnapshotTableInfoSchema: () => SnapshotTableInfoSchema,
  SseMessageSchema: () => SseMessageSchema,
  SseParser: () => SseParser,
  SubscriptionSchema: () => SubscriptionSchema,
  TICKER_ACQUISITIONS: () => TICKER_ACQUISITIONS,
  TICKER_ALIASES: () => TICKER_ALIASES,
  TICKER_RENAMES: () => TICKER_RENAMES,
  TickerBacktestSchema: () => TickerBacktestSchema,
  TickerLeaderSchema: () => TickerLeaderSchema,
  TransactionsPageSchema: () => TransactionsPageSchema,
  TransactionsQuerySchema: () => TransactionsQuerySchema,
  TxTypeSchema: () => TxTypeSchema,
  UsageTelemetryBatchSchema: () => UsageTelemetryBatchSchema,
  UsageTelemetryBillingModeSchema: () => UsageTelemetryBillingModeSchema,
  UsageTelemetryConfidenceSchema: () => UsageTelemetryConfidenceSchema,
  UsageTelemetryEventSchema: () => UsageTelemetryEventSchema,
  UsageTelemetryIngestResponseSchema: () => UsageTelemetryIngestResponseSchema,
  UsageTelemetryLimitWindowSchema: () => UsageTelemetryLimitWindowSchema,
  UsageTelemetryMetadataSchema: () => UsageTelemetryMetadataSchema,
  UsageTelemetryMetricTypeSchema: () => UsageTelemetryMetricTypeSchema,
  UsageTelemetryUnitSchema: () => UsageTelemetryUnitSchema,
  WELL_FORMED_TICKER: () => WELL_FORMED_TICKER,
  WINDOW_PRESETS: () => WINDOW_PRESETS,
  bracketMidpoint: () => bracketMidpoint,
  buildCallClassifier: () => buildCallClassifier,
  buildOperationInFlightRejection: () => buildOperationInFlightRejection,
  buildRateLimitedRejection: () => buildRateLimitedRejection,
  classifyTickerAlias: () => classifyTickerAlias,
  clean: () => clean,
  createCongressEvent: () => createCongressEvent,
  createUsageTelemetryClient: () => createUsageTelemetryClient,
  daysBetween: () => daysBetween,
  deriveUsageTelemetryIdempotencyKey: () => deriveUsageTelemetryIdempotencyKey,
  getOperationGuardHttpStatus: () => getOperationGuardHttpStatus,
  isIsoDate: () => isIsoDate,
  isPlaceholderTicker: () => isPlaceholderTicker,
  isValidBracket: () => isValidBracket,
  isWellFormedTicker: () => isWellFormedTicker,
  marketCapBucket: () => marketCapBucket,
  matchBracket: () => matchBracket,
  mergeRefs: () => mergeRefs,
  nearestBracket: () => nearestBracket,
  normalizePreferredTickerVariant: () => normalizePreferredTickerVariant,
  normalizeSecurityRef: () => normalizeSecurityRef,
  normalizeTicker: () => normalizeTicker,
  openrouterRequestEnrichment: () => openrouterRequestEnrichment,
  parseArray: () => parseArray,
  parseSafe: () => parseSafe,
  punctuationVariants: () => punctuationVariants,
  resolveContinuousTicker: () => resolveContinuousTicker,
  resolvePreferredTickerFromAssetName: () => resolvePreferredTickerFromAssetName,
  resolveTickerAlias: () => resolveTickerAlias,
  resolveTickerDeterministic: () => resolveTickerDeterministic,
  signCongressWebhook: () => signCongressWebhook,
  stripPreferredSeries: () => stripPreferredSeries,
  telemetryEventClassifier: () => telemetryEventClassifier,
  usageMonitorIngestUrl: () => usageMonitorIngestUrl,
  verifyCongressWebhookSignature: () => verifyCongressWebhookSignature
});
module.exports = __toCommonJS(index_exports);

// src/constants.ts
var TICKER_RENAMES = Object.freeze({
  FB: "META",
  // Facebook, Inc. → Meta Platforms, Inc.; ticker change 2022-06-09, same CIK/listing.
  SQ: "XYZ",
  // Block, Inc. ticker change SQ → XYZ (2025); same entity, continuous listing.
  GEHCV: "GEHC"
  // GE HealthCare when-issued (GEHCV) → regular-way (GEHC) after the 2023 GE spin-off.
});
var TICKER_ACQUISITIONS = Object.freeze({
  BRCM: "AVGO",
  // Broadcom Corp (BRCM) acquired by Avago, closed 2016-02-01 (mixed cash+stock); BRCM delisted, Avago renamed itself Broadcom Ltd and continues as AVGO (AVGO is Avago's own series, not BRCM's).
  TWX: "WBD",
  // Time Warner (TWX) acquired by AT&T 2018 — TWX holders received AT&T (T) stock and TWX's series ended there. WBD is a DOWNSTREAM 2022 entity (AT&T's WarnerMedia spun off + merged with Discovery); curated as the current successor for display, NOT the direct 2018 successor.
  ATVI: "MSFT",
  // Activision Blizzard (ATVI) acquired by Microsoft 2023 (all-cash); ATVI delisted, holders received cash, not MSFT shares.
  RHT: "IBM"
  // Red Hat (RHT) acquired by IBM 2019 (all-cash); RHT delisted, holders received cash, not IBM shares.
});
var TICKER_ALIASES = Object.freeze({
  ...TICKER_RENAMES,
  ...TICKER_ACQUISITIONS
});
var MKT_CAP_THRESHOLDS = Object.freeze({
  MEGA: 2e11,
  // $200B+
  LARGE: 1e10,
  // $10B+
  MID: 2e9,
  // $2B+
  SMALL: 3e8,
  // $300M+
  MICRO: 5e7
  // $50M+
});
var API_PATHS = Object.freeze({
  HEALTH: "/api/health",
  TRANSACTIONS: "/api/transactions",
  STREAM: "/api/stream",
  MARKET_BUNDLE: "/api/market/bundle",
  MARKET_REF: "/api/market/ref",
  MARKET_REFS: "/api/market/refs",
  MARKET_PRICES: "/api/market/prices",
  MARKET_SPX: "/api/market/spx",
  MARKET_FUNDAMENTALS: "/api/market/fundamentals",
  MARKET_ANALYST: "/api/market/analyst",
  MARKET_INSIDER: "/api/market/insider",
  MARKET_SHORT_VOLUME: "/api/market/short-volume",
  ANALYTICS_TICKER_LEADERBOARD: "/api/analytics/ticker-leaderboard",
  ANALYTICS_CONVICTION: "/api/analytics/conviction",
  ANALYTICS_MEMBER_LEADERBOARD: "/api/analytics/member-leaderboard",
  ANALYTICS_CLUSTER_BUYS: "/api/analytics/cluster-buys",
  ANALYTICS_MEMBER_PERFORMANCE: "/api/analytics/member",
  ANALYTICS_TICKER_BACKTEST: "/api/analytics/ticker",
  ANALYTICS_CONFLICTS: "/api/analytics/conflicts",
  ADMIN_SECURITIES_IMPORT: "/api/admin/securities/import",
  EXPORT_BULK_SNAPSHOT: "/api/export/bulk-snapshot",
  SUBSCRIPTIONS: "/api/subscriptions"
});
var WINDOW_PRESETS = Object.freeze([
  "1d",
  "7d",
  "30d",
  "90d",
  "180d",
  "365d",
  "1825d",
  "all"
]);
var LAG_BUCKETS = Object.freeze([
  Object.freeze({ label: "0-7d", max: 7 }),
  Object.freeze({ label: "8-14d", max: 14 }),
  Object.freeze({ label: "15-30d", max: 30 }),
  Object.freeze({ label: "31-45d", max: 45 }),
  Object.freeze({ label: "46-60d", max: 60 }),
  Object.freeze({ label: "60d+", max: null })
]);
var DEFAULT_CONGRESS_TRADE_BASE_URL = "https://congress.trade";
var DEFAULT_TRANSACTIONS_LIMIT = 100;
var MAX_REFS_BATCH = 500;
var APP_B_ORIGIN_TAG = "app-b";
var CONGRESS_EVENT_TYPES = Object.freeze([
  "congress.trade",
  "insider.update",
  "ref.upsert",
  "price.eod",
  "spx.eod"
]);

// src/schemas.ts
var import_zod = require("zod");

// src/utils.ts
var WELL_FORMED_TICKER = /^[A-Z]{1,5}(\^[A-Z0-9]{1,2}|[.-][A-Z]{1,2})?$/;
var PLACEHOLDER_TICKERS = /* @__PURE__ */ new Set(["", "-", "--", "---", "N/A", "NA", "NONE", "NULL", "\u2014"]);
function clean(raw) {
  return (raw ?? "").trim().toUpperCase().replace(/^[("'[\s]+|[)"'\]\s]+$/g, "").trim();
}
function normalizeTicker(raw) {
  if (!raw) return null;
  const cleaned = raw.trim().toUpperCase();
  if (!WELL_FORMED_TICKER.test(cleaned)) return null;
  return cleaned;
}
function isPlaceholderTicker(raw) {
  const c = clean(raw);
  return c === "" || PLACEHOLDER_TICKERS.has(c);
}
function stripPreferredSeries(sym) {
  return sym.replace(/\$[A-Z0-9]+$/, "");
}
function normalizePreferredTickerVariant(raw) {
  const sym = clean(raw);
  if (!sym) return null;
  let m = /^([A-Z]{1,5})\^([A-Z0-9]{1,2})$/.exec(sym);
  if (m) return `${m[1]}^${m[2]}`;
  m = /^([A-Z]{1,5})\$([A-Z0-9]{1,2})$/.exec(sym);
  if (m) return `${m[1]}^${m[2]}`;
  m = /^([A-Z]{1,5})-P([A-Z0-9])$/.exec(sym);
  if (m) return `${m[1]}^${m[2]}`;
  m = /^([A-Z]{1,5})[.-]PR([A-Z0-9])$/.exec(sym);
  if (m) return `${m[1]}^${m[2]}`;
  m = /^([A-Z]{1,5})\s+PR\s+([A-Z0-9])$/.exec(sym);
  if (m) return `${m[1]}^${m[2]}`;
  m = /^([A-Z]{1,5})\s+P(?:R)?([A-Z0-9])$/.exec(sym);
  if (m) return `${m[1]}^${m[2]}`;
  return null;
}
function normalizedAssetText(value) {
  return value.toUpperCase().replace(/&/g, " AND ").replace(/[^A-Z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}
function preferredIssuerName(assetName) {
  const idx = assetName.search(/\b(?:DEPOSITARY\s+SHARES?|PREFERRED|PREFERENCE|PFD|PREF)\b/i);
  if (idx <= 0) return null;
  return assetName.slice(0, idx).trim().replace(/[,;:\s]+$/g, "");
}
function resolvePreferredTickerFromAssetName(assetName, resolveIssuerTicker) {
  if (!assetName) return null;
  const text = normalizedAssetText(assetName);
  if (!/\b(?:DEPOSITARY SHARES?|PREFERRED|PREFERENCE|PFD|PREF)\b/.test(text)) return null;
  if (text.includes("JPMORGAN CHASE") && text.includes("DEPOSITARY SHARES") && text.includes("SERIES GG")) {
    return "JPM^J";
  }
  const series = /\bSERIES\s+([A-Z0-9]{1,3})\b/.exec(text)?.[1];
  if (!series || series.length !== 1) return null;
  const issuerName = preferredIssuerName(assetName);
  if (!issuerName) return null;
  const issuer = resolveIssuerTicker(issuerName);
  return issuer ? `${issuer}^${series}` : null;
}
function punctuationVariants(sym) {
  return Array.from(
    /* @__PURE__ */ new Set([sym, sym.replace(/[.-]/g, ""), sym.replace(/\./g, "-"), sym.replace(/-/g, ".")])
  ).filter(Boolean);
}
function isWellFormedTicker(sym) {
  return WELL_FORMED_TICKER.test(sym);
}
function resolveTickerDeterministic(raw, isKnown) {
  const cleaned = clean(raw);
  if (cleaned === "" || PLACEHOLDER_TICKERS.has(cleaned)) return null;
  const preferred = normalizePreferredTickerVariant(cleaned);
  if (preferred) return preferred;
  const base = stripPreferredSeries(cleaned) || cleaned;
  for (const candidate of punctuationVariants(base)) {
    const hit = isKnown(candidate);
    if (hit) return hit;
  }
  const aliasCleaned = resolveContinuousTicker(cleaned);
  if (aliasCleaned !== cleaned) return isKnown(aliasCleaned) ?? aliasCleaned;
  const aliasBase = resolveContinuousTicker(base);
  if (aliasBase !== base) return isKnown(aliasBase) ?? aliasBase;
  if (isWellFormedTicker(base)) return base;
  return null;
}
function resolveTickerAlias(ticker, aliases = TICKER_ALIASES) {
  const normalized = normalizeTicker(ticker) ?? ticker.trim().toUpperCase();
  return aliases[normalized] ?? normalized;
}
function classifyTickerAlias(ticker, opts) {
  const renames = opts?.renames ?? TICKER_RENAMES;
  const acquisitions = opts?.acquisitions ?? TICKER_ACQUISITIONS;
  const from = normalizeTicker(ticker) ?? ticker.trim().toUpperCase();
  const renamed = renames[from];
  if (renamed !== void 0) return { from, to: renamed, class: "rename" };
  const acquired = acquisitions[from];
  if (acquired !== void 0) return { from, to: acquired, class: "acquisition" };
  return null;
}
function resolveContinuousTicker(ticker, renames = TICKER_RENAMES) {
  const normalized = normalizeTicker(ticker) ?? ticker.trim().toUpperCase();
  return renames[normalized] ?? normalized;
}
function marketCapBucket(n) {
  if (n == null || !Number.isFinite(n) || n <= 0) return null;
  if (n >= MKT_CAP_THRESHOLDS.MEGA) return "mega";
  if (n >= MKT_CAP_THRESHOLDS.LARGE) return "large";
  if (n >= MKT_CAP_THRESHOLDS.MID) return "mid";
  if (n >= MKT_CAP_THRESHOLDS.SMALL) return "small";
  if (n >= MKT_CAP_THRESHOLDS.MICRO) return "micro";
  return "nano";
}
function bracketMidpoint(min, max) {
  if (max != null && min != null) return (min + max) / 2;
  if (min != null) return min;
  return 0;
}
var ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function isIsoDate(s) {
  if (!ISO_DATE.test(s)) return false;
  const d = /* @__PURE__ */ new Date(s + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function daysBetween(a, b) {
  const da = /* @__PURE__ */ new Date(a + "T00:00:00Z");
  const db = /* @__PURE__ */ new Date(b + "T00:00:00Z");
  return Math.round((db.getTime() - da.getTime()) / 864e5);
}
function mergeRefs(a, b) {
  const result = { ...a ?? {} };
  if (b) {
    for (const [k, v] of Object.entries(b)) {
      if (v !== null && v !== void 0) result[k] = v;
    }
  }
  return result;
}

// src/schemas.ts
var nullAsUndefined = (schema) => import_zod.z.preprocess((value) => value === null ? void 0 : value, schema.optional());
var IsoDateSchema = import_zod.z.string().refine(isIsoDate, {
  message: "Expected a valid YYYY-MM-DD date"
});
var ChamberSchema = import_zod.z.enum(["house", "senate", "executive"]);
var PartyBucketSchema = import_zod.z.enum(["D", "R", "O"]);
var OwnerSchema = import_zod.z.enum(["self", "spouse", "joint", "dependent"]);
var TxTypeSchema = import_zod.z.enum(["P", "S", "E"]);
var AssetTypeCategorySchema = import_zod.z.enum([
  "public_equity",
  "private_equity",
  "option",
  "fund",
  "fixed_income_government",
  "fixed_income_corporate",
  "fixed_income_asset_backed",
  "cash",
  "retirement_or_529",
  "real_estate",
  "private_fund",
  "business_interest",
  "crypto",
  "insurance_annuity",
  "trust",
  "commodity_collectible",
  "derivative",
  "intellectual_property",
  "receivable",
  "other_security",
  "other",
  "unknown"
]);
var MktCapBucketSchema = import_zod.z.enum([
  "mega",
  "large",
  "mid",
  "small",
  "micro",
  "nano"
]);
var PriceCloseSchema = import_zod.z.object({
  date: IsoDateSchema,
  close: import_zod.z.number(),
  volume: nullAsUndefined(import_zod.z.number())
});
var SecurityRefSchema = import_zod.z.object({
  ticker: import_zod.z.string().min(1).max(20),
  companyName: import_zod.z.string().nullable(),
  sector: import_zod.z.string().nullable(),
  industry: import_zod.z.string().nullable(),
  assetClass: import_zod.z.string().nullable(),
  isEtf: import_zod.z.boolean(),
  isAdr: import_zod.z.boolean(),
  country: import_zod.z.string().nullable(),
  stateHq: import_zod.z.string().nullable(),
  stateOfIncorp: import_zod.z.string().nullable(),
  exchange: import_zod.z.string().nullable(),
  exchangeShort: import_zod.z.string().nullable(),
  currency: import_zod.z.string().nullable(),
  marketCap: import_zod.z.number().nullable(),
  marketCapBucket: MktCapBucketSchema.nullable(),
  sharesOutstanding: import_zod.z.number().nullable(),
  ipoDate: import_zod.z.string().nullable(),
  cik: import_zod.z.string().nullable(),
  sicCode: import_zod.z.string().nullable(),
  sicDescription: import_zod.z.string().nullable(),
  source: import_zod.z.string().nullable(),
  enrichedAt: import_zod.z.string().nullable().optional(),
  currentPrice: import_zod.z.number().nullable().optional(),
  currentPriceDate: IsoDateSchema.nullable().optional()
});
var SecurityRefInputSchema = SecurityRefSchema.partial().extend({
  ticker: import_zod.z.string().min(1).max(20)
});
var CongressTransactionSchema = import_zod.z.object({
  id: import_zod.z.string().min(1),
  docId: import_zod.z.string().min(1),
  filerId: import_zod.z.string().nullable(),
  txDate: import_zod.z.string().nullable(),
  owner: OwnerSchema.nullable(),
  assetName: import_zod.z.string(),
  ticker: import_zod.z.string().nullable(),
  assetType: import_zod.z.string().nullable(),
  assetTypeName: import_zod.z.string().nullable().optional(),
  assetTypeCategory: AssetTypeCategorySchema.nullable().optional(),
  assetTypeCategoryLabel: import_zod.z.string().nullable().optional(),
  txType: TxTypeSchema,
  amountMin: import_zod.z.number().nullable(),
  amountMax: import_zod.z.number().nullable(),
  estValue: import_zod.z.number().nullable().optional(),
  isOption: import_zod.z.boolean(),
  capGainsOver200: import_zod.z.boolean(),
  rawText: import_zod.z.string(),
  filingStatus: import_zod.z.string().nullable().optional(),
  subholding: import_zod.z.string().nullable().optional(),
  location: import_zod.z.string().nullable().optional(),
  description: import_zod.z.string().nullable().optional(),
  supplementalText: import_zod.z.string().nullable().optional(),
  confidence: import_zod.z.number().optional(),
  source: import_zod.z.enum(["primary", "seed_dataset", "manual"]).optional(),
  rowKey: import_zod.z.string().nullable().optional(),
  createdAt: import_zod.z.string().optional(),
  cursorSeq: import_zod.z.number().int().nonnegative().optional(),
  chamber: ChamberSchema.nullable().optional(),
  memberName: import_zod.z.string().nullable().optional(),
  filedDate: import_zod.z.string().nullable().optional(),
  fullName: import_zod.z.string().nullable().optional(),
  state: import_zod.z.string().nullable().optional(),
  photoUrl: import_zod.z.string().nullable().optional(),
  firstSeenAt: import_zod.z.string().nullable().optional(),
  sourceUrl: import_zod.z.string().nullable().optional(),
  refCompanyName: import_zod.z.string().nullable().optional(),
  refSector: import_zod.z.string().nullable().optional(),
  refMarketCap: import_zod.z.number().nullable().optional(),
  refMarketCapBucket: import_zod.z.string().nullable().optional(),
  refCountry: import_zod.z.string().nullable().optional(),
  refExchangeShort: import_zod.z.string().nullable().optional(),
  refAssetClass: import_zod.z.string().nullable().optional()
});
var CongressTransactionReadSchema = CongressTransactionSchema.extend({
  confidence: import_zod.z.number(),
  source: import_zod.z.enum(["primary", "seed_dataset", "manual"]),
  createdAt: import_zod.z.string(),
  cursorSeq: import_zod.z.number().int().nonnegative()
});
var TransactionsPageSchema = import_zod.z.object({
  transactions: import_zod.z.array(CongressTransactionReadSchema),
  cursor: import_zod.z.number().int().nonnegative(),
  count: import_zod.z.number().int().nonnegative(),
  total: import_zod.z.number().int().nonnegative(),
  limit: import_zod.z.number().int().positive(),
  offset: import_zod.z.number().int().nonnegative().optional(),
  filingsImportedToday: import_zod.z.number().int().nonnegative().optional()
});
var TransactionsQuerySchema = import_zod.z.object({
  since: import_zod.z.union([
    import_zod.z.string().regex(/^\d+$/, "Expected a non-negative integer cursor"),
    import_zod.z.number().int().nonnegative()
  ]).optional(),
  from: IsoDateSchema.optional(),
  to: IsoDateSchema.optional(),
  ticker: import_zod.z.string().optional(),
  member: import_zod.z.string().optional(),
  chamber: ChamberSchema.optional(),
  type: TxTypeSchema.optional(),
  limit: import_zod.z.number().int().positive().optional(),
  order: import_zod.z.enum(["asc", "desc"]).optional()
});
var FundamentalRowSchema = import_zod.z.object({
  ticker: import_zod.z.string(),
  date: IsoDateSchema,
  peRatio: nullAsUndefined(import_zod.z.number()),
  eps: nullAsUndefined(import_zod.z.number()),
  beta: nullAsUndefined(import_zod.z.number()),
  dividendYield: nullAsUndefined(import_zod.z.number()),
  week52High: nullAsUndefined(import_zod.z.number()),
  week52Low: nullAsUndefined(import_zod.z.number()),
  fcfYield: nullAsUndefined(import_zod.z.number()),
  debtToEquity: nullAsUndefined(import_zod.z.number()),
  epsGrowth: nullAsUndefined(import_zod.z.number()),
  source: nullAsUndefined(import_zod.z.string()),
  updatedAt: import_zod.z.string().optional()
});
var AnalystRowSchema = import_zod.z.object({
  ticker: import_zod.z.string(),
  date: IsoDateSchema,
  rating: nullAsUndefined(import_zod.z.string()),
  strongBuy: nullAsUndefined(import_zod.z.number()),
  buy: nullAsUndefined(import_zod.z.number()),
  hold: nullAsUndefined(import_zod.z.number()),
  sell: nullAsUndefined(import_zod.z.number()),
  strongSell: nullAsUndefined(import_zod.z.number()),
  targetMean: nullAsUndefined(import_zod.z.number()),
  targetHigh: nullAsUndefined(import_zod.z.number()),
  targetLow: nullAsUndefined(import_zod.z.number()),
  targetMedian: nullAsUndefined(import_zod.z.number()),
  analystCount: nullAsUndefined(import_zod.z.number()),
  source: nullAsUndefined(import_zod.z.string()),
  updatedAt: import_zod.z.string().optional()
});
var InsiderRowSchema = import_zod.z.object({
  ticker: import_zod.z.string(),
  date: IsoDateSchema,
  sentiment: import_zod.z.number(),
  buyFilings: import_zod.z.number(),
  sellFilings: import_zod.z.number(),
  buyShares: import_zod.z.number(),
  sellShares: import_zod.z.number(),
  owners: import_zod.z.array(import_zod.z.string())
});
var InsiderReadRowSchema = InsiderRowSchema.extend({
  sentiment: import_zod.z.number().nullable(),
  buyFilings: import_zod.z.number().nullable(),
  sellFilings: import_zod.z.number().nullable(),
  buyShares: import_zod.z.number().nullable(),
  sellShares: import_zod.z.number().nullable()
});
var ShortVolumeRowSchema = import_zod.z.object({
  ticker: import_zod.z.string(),
  date: IsoDateSchema,
  ratio: import_zod.z.number(),
  elevated: import_zod.z.boolean()
});
var ShortVolumeReadRowSchema = ShortVolumeRowSchema.extend({
  ratio: import_zod.z.number().nullable()
});
var PriceSeriesSchema = import_zod.z.object({
  ticker: import_zod.z.string(),
  closes: import_zod.z.array(PriceCloseSchema),
  currentPrice: nullAsUndefined(import_zod.z.number()),
  currentPriceDate: nullAsUndefined(IsoDateSchema)
});
var SharePayloadSchema = import_zod.z.object({
  refs: import_zod.z.array(SecurityRefInputSchema).optional(),
  spx: import_zod.z.array(PriceCloseSchema).optional(),
  prices: import_zod.z.array(PriceSeriesSchema).optional(),
  insider: import_zod.z.array(InsiderRowSchema).optional(),
  shortVolume: import_zod.z.array(ShortVolumeRowSchema).optional(),
  fundamentals: import_zod.z.array(FundamentalRowSchema).optional(),
  analyst: import_zod.z.array(AnalystRowSchema).optional(),
  origin: import_zod.z.string().optional()
});
var BundleResponseSchema = import_zod.z.object({
  ticker: import_zod.z.string(),
  ref: SecurityRefSchema.nullable(),
  prices: PriceSeriesSchema.nullable(),
  spx: import_zod.z.array(PriceCloseSchema)
});
var CongressEventTypeSchema = import_zod.z.enum(CONGRESS_EVENT_TYPES);
var CongressEventSchema = import_zod.z.object({
  type: CongressEventTypeSchema.or(import_zod.z.string().trim().min(1)),
  id: import_zod.z.string().trim().min(1).optional(),
  seq: import_zod.z.number().int().nonnegative().optional(),
  emittedAt: import_zod.z.string().datetime().optional(),
  data: import_zod.z.unknown().optional()
});
var ConvictionTickerSchema = import_zod.z.object({
  ticker: import_zod.z.string(),
  name: nullAsUndefined(import_zod.z.string()),
  convictionScore: import_zod.z.number().nullable(),
  direction: import_zod.z.enum(["BUY", "SELL"]).nullable(),
  fallback: import_zod.z.boolean().optional(),
  memberCount: import_zod.z.number().optional(),
  tradeCount: import_zod.z.number().optional(),
  directionalMembers: import_zod.z.number().optional(),
  directionalTrades: import_zod.z.number().optional(),
  netSentiment: import_zod.z.number().optional(),
  estNetFlowUsd: import_zod.z.number().optional(),
  parties: import_zod.z.record(import_zod.z.string(), import_zod.z.number()).optional(),
  components: import_zod.z.record(import_zod.z.string(), import_zod.z.unknown()).optional()
});
var TickerLeaderSchema = import_zod.z.object({
  ticker: import_zod.z.string(),
  name: nullAsUndefined(import_zod.z.string()),
  tradeCount: import_zod.z.number().optional(),
  buyCount: import_zod.z.number().optional(),
  sellCount: import_zod.z.number().optional(),
  memberCount: import_zod.z.number().optional(),
  estVolumeUsd: import_zod.z.number().optional(),
  estNetFlowUsd: import_zod.z.number().optional(),
  netSentiment: import_zod.z.number().optional()
});
var ClusterBuySchema = import_zod.z.object({
  ticker: nullAsUndefined(import_zod.z.string()),
  name: nullAsUndefined(import_zod.z.string()),
  txType: nullAsUndefined(import_zod.z.string()),
  memberCount: import_zod.z.number().optional(),
  tradeCount: import_zod.z.number().optional(),
  estVolumeUsd: import_zod.z.number().optional(),
  firstSeen: nullAsUndefined(import_zod.z.string()),
  lastSeen: nullAsUndefined(import_zod.z.string()),
  parties: import_zod.z.record(import_zod.z.string(), import_zod.z.number()).optional(),
  topMembers: import_zod.z.array(import_zod.z.object({
    filerId: nullAsUndefined(import_zod.z.string()),
    fullName: nullAsUndefined(import_zod.z.string()),
    memberName: nullAsUndefined(import_zod.z.string()),
    name: nullAsUndefined(import_zod.z.string()),
    partyBucket: PartyBucketSchema.nullable().optional(),
    photoUrl: nullAsUndefined(import_zod.z.string()),
    tradeCount: import_zod.z.number().optional()
  })).optional()
});
var MemberLeaderSchema = import_zod.z.object({
  filerId: nullAsUndefined(import_zod.z.string()),
  fullName: nullAsUndefined(import_zod.z.string()),
  memberName: nullAsUndefined(import_zod.z.string()),
  name: nullAsUndefined(import_zod.z.string()),
  party: nullAsUndefined(import_zod.z.string()),
  partyBucket: PartyBucketSchema.nullable().optional(),
  chamber: ChamberSchema.nullable().optional(),
  state: nullAsUndefined(import_zod.z.string()),
  photoUrl: nullAsUndefined(import_zod.z.string()),
  tradeCount: import_zod.z.number().optional(),
  buyCount: import_zod.z.number().optional(),
  sellCount: import_zod.z.number().optional(),
  uniqueTickers: import_zod.z.number().optional(),
  estVolumeUsd: import_zod.z.number().optional(),
  estNetFlowUsd: import_zod.z.number().optional(),
  netSentiment: import_zod.z.number().optional()
});
var MemberPerformanceSchema = import_zod.z.object({
  tradeCount: import_zod.z.number().optional(),
  scoredCount: import_zod.z.number().optional(),
  winRate: import_zod.z.number().nullable().optional(),
  medianReturn: import_zod.z.number().nullable().optional(),
  medianExcess: import_zod.z.number().nullable().optional(),
  avgReturn: import_zod.z.number().nullable().optional(),
  avgExcess: import_zod.z.number().nullable().optional()
});
var BacktestHorizonSchema = import_zod.z.object({
  days: import_zod.z.number(),
  tradeCount: import_zod.z.number(),
  n: import_zod.z.number(),
  medianReturn: import_zod.z.number().nullable(),
  avgReturn: import_zod.z.number().nullable(),
  winRate: import_zod.z.number().nullable(),
  medianExcess: import_zod.z.number().nullable(),
  avgExcess: import_zod.z.number().nullable()
});
var TickerBacktestSchema = import_zod.z.object({
  ticker: import_zod.z.string(),
  filerId: import_zod.z.string().nullable().optional(),
  txType: import_zod.z.string(),
  totalBuyEvents: import_zod.z.number(),
  pricedDays: import_zod.z.number(),
  horizons: import_zod.z.array(BacktestHorizonSchema)
});
var CommitteeConflictSchema = import_zod.z.object({
  id: import_zod.z.string().nullable(),
  ticker: import_zod.z.string().nullable(),
  sector: import_zod.z.string(),
  txType: import_zod.z.string().nullable(),
  txDate: import_zod.z.string().nullable(),
  filerId: import_zod.z.string().nullable(),
  memberName: import_zod.z.string().nullable(),
  chamber: import_zod.z.string().nullable(),
  partyBucket: PartyBucketSchema.nullable(),
  viaCommittees: import_zod.z.array(import_zod.z.string()),
  estAmountUsd: import_zod.z.number()
});
var SnapshotTableInfoSchema = import_zod.z.object({
  objectKey: import_zod.z.string(),
  rowCount: import_zod.z.number()
});
var SnapshotManifestSchema = import_zod.z.object({
  generatedAt: import_zod.z.string(),
  snapshotDate: IsoDateSchema,
  runId: import_zod.z.string(),
  format: import_zod.z.literal("ndjson"),
  tables: import_zod.z.record(import_zod.z.string(), SnapshotTableInfoSchema),
  schema: import_zod.z.record(import_zod.z.string(), import_zod.z.array(import_zod.z.string()))
});
var ClientMemberSchema = import_zod.z.object({
  id: import_zod.z.string().nullable(),
  name: import_zod.z.string().nullable(),
  chamber: ChamberSchema.nullable(),
  party: import_zod.z.string().nullable(),
  state: import_zod.z.string().nullable(),
  photoUrl: import_zod.z.string().nullable()
});
var ClientAssetSchema = import_zod.z.object({
  name: import_zod.z.string(),
  ticker: import_zod.z.string().nullable(),
  type: import_zod.z.string().nullable(),
  sector: import_zod.z.string().nullable(),
  marketCapBucket: import_zod.z.string().nullable(),
  companyName: import_zod.z.string().nullable().optional(),
  logoUrl: import_zod.z.string().nullable().optional(),
  typeName: import_zod.z.string().nullable().optional(),
  typeCategory: import_zod.z.string().nullable().optional(),
  typeCategoryLabel: import_zod.z.string().nullable().optional()
});
var ClientTransactionSchema = import_zod.z.object({
  date: import_zod.z.string().nullable(),
  type: TxTypeSchema,
  owner: import_zod.z.string().nullable(),
  amountMin: import_zod.z.number().nullable(),
  amountMax: import_zod.z.number().nullable(),
  estValue: import_zod.z.number().nullable().optional(),
  isOption: import_zod.z.boolean()
});
var ClientFilingSchema = import_zod.z.object({
  filedDate: import_zod.z.string().nullable(),
  firstSeenAt: import_zod.z.string().nullable(),
  sourceUrl: import_zod.z.string().nullable()
});
var ClientTradeSchema = import_zod.z.object({
  id: import_zod.z.string(),
  cursor: import_zod.z.number(),
  docId: import_zod.z.string(),
  member: ClientMemberSchema,
  asset: ClientAssetSchema,
  transaction: ClientTransactionSchema,
  filing: ClientFilingSchema,
  confidence: import_zod.z.number(),
  source: import_zod.z.enum(["primary", "seed_dataset", "manual"])
});
var AmountBracketSchema = import_zod.z.object({
  min: import_zod.z.number().finite().nonnegative(),
  max: import_zod.z.number().finite().nonnegative().nullable()
}).refine((data) => data.max === null || data.max >= data.min, {
  message: "max must be greater than or equal to min",
  path: ["max"]
});
var SubscriptionSchema = import_zod.z.object({
  id: import_zod.z.string().min(1),
  secret: import_zod.z.string().min(16).max(256),
  streamUrl: import_zod.z.string().optional()
});
var SseMessageSchema = import_zod.z.object({
  event: import_zod.z.string().optional(),
  id: import_zod.z.string().optional(),
  data: import_zod.z.string()
});
function parseArray(schema, data) {
  const result = import_zod.z.array(schema).safeParse(data);
  return result.success ? result.data : null;
}
function parseSafe(schema, data) {
  const result = schema.safeParse(data);
  return result.success ? result.data : null;
}

// src/usageTelemetry.ts
var import_zod2 = require("zod");
var UsageTelemetryMetricTypeSchema = import_zod2.z.enum([
  "usage",
  "cost",
  "quota",
  "tier",
  "health",
  "balance",
  "limit",
  "quota_sync",
  "credit_balance",
  // Recurring fixed-cost events materialized by the API Usage Monitor
  // (subscription-materializer). Kept in the shared enum so producers can
  // validate before send; monitor already accepts this value.
  "subscription"
]);
var UsageTelemetryUnitSchema = import_zod2.z.enum([
  "request",
  "call",
  "token",
  "credit",
  "usd",
  "page",
  "job",
  "document",
  "row",
  "byte"
]);
var UsageTelemetryBillingModeSchema = import_zod2.z.enum([
  "actual",
  "estimated",
  "manual"
]);
var UsageTelemetryConfidenceSchema = import_zod2.z.enum([
  "actual",
  "estimated",
  "manual"
]);
var UsageTelemetryLimitWindowSchema = import_zod2.z.enum([
  "minute",
  "day",
  "month",
  "run"
]);
var UsageTelemetryMetadataSchema = import_zod2.z.record(
  import_zod2.z.string(),
  import_zod2.z.union([import_zod2.z.string(), import_zod2.z.number().finite(), import_zod2.z.boolean(), import_zod2.z.null()])
).transform((metadata) => {
  const clean2 = {};
  for (const [rawKey, rawValue] of Object.entries(metadata).slice(0, 50)) {
    const key = rawKey.trim().slice(0, 80);
    if (!key) continue;
    clean2[key] = typeof rawValue === "string" ? rawValue.slice(0, 500) : rawValue;
  }
  return clean2;
});
var UsageTelemetryEventSchema = import_zod2.z.object({
  sourceApp: import_zod2.z.string().trim().min(1).max(80),
  environment: import_zod2.z.string().trim().min(1).max(80).optional(),
  provider: import_zod2.z.string().trim().min(1).max(80),
  service: import_zod2.z.string().trim().min(1).max(120).optional(),
  // Per-project attribution name. Resolved to Project.id on the monitor at
  // ingest. Deliberately NOT part of the idempotency basis — adding it there
  // would rekey existing events.
  project: import_zod2.z.string().trim().min(1).max(120).optional(),
  label: import_zod2.z.string().trim().min(1).max(160).optional(),
  keyRef: import_zod2.z.string().trim().min(1).max(160).optional(),
  billingMode: UsageTelemetryBillingModeSchema.default("estimated"),
  metricType: UsageTelemetryMetricTypeSchema.default("usage"),
  quantity: import_zod2.z.number().finite().nonnegative().optional(),
  unit: UsageTelemetryUnitSchema.optional(),
  costUsd: import_zod2.z.number().finite().nonnegative().optional(),
  requests: import_zod2.z.number().int().nonnegative().optional(),
  credits: import_zod2.z.number().finite().nonnegative().optional(),
  limit: import_zod2.z.number().finite().nonnegative().optional(),
  limitWindow: UsageTelemetryLimitWindowSchema.optional(),
  tier: import_zod2.z.string().trim().min(1).max(80).optional(),
  confidence: UsageTelemetryConfidenceSchema.default("estimated"),
  windowStart: import_zod2.z.string().datetime().optional(),
  windowEnd: import_zod2.z.string().datetime().optional(),
  occurredAt: import_zod2.z.string().datetime().optional(),
  // The provider-side call/generation id (e.g. OpenRouter's `id` on a
  // completions response), pushed so the monitor can verify reported cost
  // against the provider's own record (e.g. `GET /api/v1/generation?id=...`).
  // CONTRACT: deliberately NOT part of `deriveUsageTelemetryIdempotencyKey`'s
  // basis — adding it there would change the key for existing/replayed
  // events. Keep the idempotency key derivation limited to sourceApp,
  // provider, metricType, keyRef, and occurredAt.
  providerRequestId: import_zod2.z.string().trim().min(1).max(200).optional(),
  metadata: UsageTelemetryMetadataSchema.optional(),
  idempotencyKey: import_zod2.z.string().trim().min(1).max(200).optional()
});
var UsageTelemetryBatchSchema = import_zod2.z.object({
  events: import_zod2.z.array(UsageTelemetryEventSchema).min(1).max(100)
});
var UsageTelemetryIngestResponseSchema = import_zod2.z.object({
  ok: import_zod2.z.boolean(),
  accepted: import_zod2.z.number().int().nonnegative(),
  ignoredPruned: import_zod2.z.number().int().nonnegative().optional()
});
var API_USAGE_MONITOR_INGEST_PATH = "/api/ingest/usage";
function usageMonitorIngestUrl(baseUrl) {
  return `${baseUrl.replace(/\/+$/, "")}${API_USAGE_MONITOR_INGEST_PATH}`;
}
async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function encodeIdempotencyField(value) {
  return `${new TextEncoder().encode(value).length}:${value}`;
}
async function deriveUsageTelemetryIdempotencyKey(event) {
  if (!event.occurredAt) return void 0;
  const basis = [event.sourceApp, event.provider, event.metricType, event.keyRef ?? "", event.occurredAt].map(encodeIdempotencyField).join("");
  return sha256Hex(basis);
}
function createUsageTelemetryClient(options) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = usageMonitorIngestUrl(options.baseUrl);
  return {
    async send(events) {
      const parsed = UsageTelemetryBatchSchema.parse({ events });
      if (options.requireExplicitIdempotencyKey) {
        const missingIndex = parsed.events.findIndex((event) => !event.idempotencyKey);
        if (missingIndex >= 0) {
          throw new Error(`Usage telemetry event ${missingIndex} requires an explicit idempotencyKey`);
        }
      }
      const body = {
        events: await Promise.all(
          parsed.events.map(async (event) => {
            if (event.idempotencyKey) return event;
            const idempotencyKey = await deriveUsageTelemetryIdempotencyKey(event);
            return idempotencyKey ? { ...event, idempotencyKey } : event;
          })
        )
      };
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(body)
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = typeof payload === "object" && payload && "error" in payload ? String(payload.error) : `HTTP ${res.status}`;
        throw new Error(`Usage telemetry ingest failed: ${message}`);
      }
      return UsageTelemetryIngestResponseSchema.parse(payload);
    }
  };
}

// src/callClassifier.ts
var import_zod3 = require("zod");
var dynamicIdSchema = import_zod3.z.string().trim().max(128).transform((value) => value === "" ? void 0 : value).optional();
var CallClassifierContextSchema = import_zod3.z.object({
  /** Producer app identifier, e.g. "congress-trade" or "socratic-trade". */
  sourceApp: import_zod3.z.string().trim().min(1).max(80),
  /** Deploy environment, e.g. "production" | "staging" | "development". */
  environment: import_zod3.z.string().trim().min(1).max(80).optional(),
  /** Logical service/subsystem within the app, e.g. "extraction-worker". */
  service: import_zod3.z.string().trim().min(1).max(120).optional(),
  /** Finer-grained feature/call-site tag, e.g. "openrouter-vision-extract". */
  feature: import_zod3.z.string().trim().min(1).max(120).optional(),
  /** Reference to the API key used (name/alias, never the raw secret). */
  keyRef: import_zod3.z.string().trim().min(1).max(160).optional(),
  /** Deployed commit SHA or version tag for the calling build. */
  gitSha: import_zod3.z.string().trim().min(1).max(80).optional(),
  /**
   * Deterministic per-caller/end-user identifier (OpenRouter `user`, max 128
   * chars per OpenRouter's documented limit). Runtime-dynamic: blank values
   * are treated as absent, never an error.
   */
  user: dynamicIdSchema,
  /**
   * Run/session identifier grouping related calls (OpenRouter `session_id`,
   * max 128 chars per OpenRouter's documented limit). Runtime-dynamic: blank
   * values are treated as absent, never an error.
   */
  sessionId: dynamicIdSchema
});
function openrouterRequestEnrichment(ctx) {
  const parsed = CallClassifierContextSchema.parse(ctx);
  const trace = { sourceApp: parsed.sourceApp };
  if (parsed.environment !== void 0) trace.environment = parsed.environment;
  if (parsed.service !== void 0) trace.service = parsed.service;
  if (parsed.feature !== void 0) trace.feature = parsed.feature;
  if (parsed.keyRef !== void 0) trace.keyRef = parsed.keyRef;
  if (parsed.gitSha !== void 0) trace.gitSha = parsed.gitSha;
  const result = { trace };
  if (parsed.user !== void 0) result.user = parsed.user;
  if (parsed.sessionId !== void 0) result.session_id = parsed.sessionId;
  return result;
}
function telemetryEventClassifier(ctx) {
  const parsed = CallClassifierContextSchema.parse(ctx);
  const metadata = { sourceApp: parsed.sourceApp };
  if (parsed.environment !== void 0) metadata.environment = parsed.environment;
  if (parsed.service !== void 0) metadata.service = parsed.service;
  if (parsed.feature !== void 0) metadata.feature = parsed.feature;
  if (parsed.keyRef !== void 0) metadata.keyRef = parsed.keyRef;
  if (parsed.gitSha !== void 0) metadata.gitSha = parsed.gitSha;
  if (parsed.user !== void 0) metadata.user = parsed.user;
  if (parsed.sessionId !== void 0) metadata.sessionId = parsed.sessionId;
  return metadata;
}
function buildCallClassifier(ctx) {
  return {
    openrouterRequestEnrichment: openrouterRequestEnrichment(ctx),
    telemetryMetadata: telemetryEventClassifier(ctx)
  };
}

// src/client.ts
var import_zod4 = require("zod");
var RawRefEnvelopeSchema = import_zod4.z.object({ ref: import_zod4.z.unknown().nullable() });
var RawRefsEnvelopeSchema = import_zod4.z.object({ refs: import_zod4.z.array(import_zod4.z.unknown()) });
var ClosesEnvelopeSchema = import_zod4.z.object({ closes: import_zod4.z.array(PriceCloseSchema) });
var UnknownRowsEnvelopeSchema = import_zod4.z.object({
  ticker: import_zod4.z.string().optional(),
  rows: import_zod4.z.array(import_zod4.z.unknown())
});
function parseResponse(schema, value, label) {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid ${label} response: ${result.error.message}`);
  }
  return result.data;
}
function normalizeSecurityRef(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const ref = value;
  return "sharesOutstanding" in ref ? ref : { ...ref, sharesOutstanding: null };
}
var CongressTradeHttpError = class extends Error {
  constructor(method, path, status) {
    super(`Request failed: ${method} ${path} -> HTTP ${status}`);
    this.method = method;
    this.path = path;
    this.status = status;
    this.name = "CongressTradeHttpError";
  }
  method;
  path;
  status;
};
var CongressTradeClient = class {
  baseUrl;
  token;
  fetchApi;
  constructor(config = {}) {
    this.baseUrl = (config.baseUrl || DEFAULT_CONGRESS_TRADE_BASE_URL).replace(/\/+$/, "");
    this.token = config.token;
    this.fetchApi = config.fetch || globalThis.fetch;
  }
  headers(extra) {
    const h = { "content-type": "application/json", ...extra };
    if (this.token) {
      h["authorization"] = `Bearer ${this.token}`;
    }
    return h;
  }
  async getJson(path, searchParams) {
    const qs = searchParams?.toString();
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;
    const res = await this.fetchApi(url, {
      method: "GET",
      headers: this.headers({ accept: "application/json" }),
      cache: "no-store"
    });
    if (!res.ok) {
      throw new CongressTradeHttpError("GET", path, res.status);
    }
    return await res.json();
  }
  /**
   * Create an SSE subscription on behalf of an already-authenticated end user.
   * Current Congress.Trade derives ownership from the user session and ignores
   * `clientId`; the field remains on the wire for compatibility with older servers.
   */
  async createSubscription(clientId, desiredSecret) {
    const body = { delivery: "sse", clientId };
    if (desiredSecret !== void 0) {
      if (desiredSecret.length < 16 || desiredSecret.length > 256) {
        throw new RangeError("desired subscription secret must be 16-256 characters");
      }
      body.secret = desiredSecret;
    }
    const res = await this.fetchApi(`${this.baseUrl}${API_PATHS.SUBSCRIPTIONS}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      cache: "no-store"
    });
    if (!res.ok) {
      throw new CongressTradeHttpError("POST", API_PATHS.SUBSCRIPTIONS, res.status);
    }
    return parseResponse(SubscriptionSchema, await res.json(), "subscription create");
  }
  /**
   * Build an SSE URL. Pass the per-subscription secret for EventSource-style
   * clients; callers that omit it must send the same secret as a Bearer header.
   */
  streamUrl(subscriptionId, secret) {
    const params = new URLSearchParams({ subscription: subscriptionId });
    if (secret !== void 0) params.set("token", secret);
    return `${this.baseUrl}${API_PATHS.STREAM}?${params.toString()}`;
  }
  async getBundle(ticker, opts) {
    const params = new URLSearchParams();
    if (opts?.from) params.set("from", opts.from);
    if (opts?.to) params.set("to", opts.to);
    const data = await this.getJson(
      `${API_PATHS.MARKET_BUNDLE}/${encodeURIComponent(ticker)}`,
      params
    );
    return parseResponse(BundleResponseSchema, {
      ...data,
      ref: normalizeSecurityRef(data.ref)
    }, "market bundle");
  }
  async getRef(ticker) {
    const path = `${API_PATHS.MARKET_REF}/${encodeURIComponent(ticker)}`;
    try {
      const data = parseResponse(RawRefEnvelopeSchema, await this.getJson(path), "market ref envelope");
      if (data.ref === null) return null;
      return parseResponse(SecurityRefSchema, normalizeSecurityRef(data.ref), "market ref");
    } catch (error) {
      if (error instanceof CongressTradeHttpError && error.status === 404) return null;
      throw error;
    }
  }
  async getRefs(tickers) {
    if (tickers.length === 0) return [];
    const results = [];
    for (let i = 0; i < tickers.length; i += MAX_REFS_BATCH) {
      const chunk = tickers.slice(i, i + MAX_REFS_BATCH);
      const params = new URLSearchParams();
      params.set("tickers", chunk.join(","));
      const data = parseResponse(
        RawRefsEnvelopeSchema,
        await this.getJson(API_PATHS.MARKET_REFS, params),
        "market refs envelope"
      );
      results.push(...data.refs.map((ref) => parseResponse(
        SecurityRefSchema,
        normalizeSecurityRef(ref),
        "market ref"
      )));
    }
    return results;
  }
  async getPrices(ticker, opts) {
    const params = new URLSearchParams();
    if (opts?.from) params.set("from", opts.from);
    if (opts?.to) params.set("to", opts.to);
    const data = await this.getJson(`${API_PATHS.MARKET_PRICES}/${encodeURIComponent(ticker)}`, params);
    return parseResponse(PriceSeriesSchema, data, "market prices");
  }
  async getSpx(opts) {
    const params = new URLSearchParams();
    if (opts?.from) params.set("from", opts.from);
    if (opts?.to) params.set("to", opts.to);
    const data = await this.getJson(API_PATHS.MARKET_SPX, params);
    return parseResponse(ClosesEnvelopeSchema, data, "SPX prices").closes;
  }
  async getFundamentals(ticker, opts) {
    const params = new URLSearchParams();
    if (opts?.from) params.set("from", opts.from);
    if (opts?.to) params.set("to", opts.to);
    const data = await this.getJson(
      `${API_PATHS.MARKET_FUNDAMENTALS}/${encodeURIComponent(ticker)}`,
      params
    );
    const envelope = parseResponse(UnknownRowsEnvelopeSchema, data, "market fundamentals");
    const rowTicker = envelope.ticker ?? ticker.toUpperCase();
    return envelope.rows.map((row) => parseResponse(
      FundamentalRowSchema,
      { ...row && typeof row === "object" ? row : {}, ticker: rowTicker },
      "fundamental row"
    ));
  }
  async getAnalyst(ticker, opts) {
    const params = new URLSearchParams();
    if (opts?.from) params.set("from", opts.from);
    if (opts?.to) params.set("to", opts.to);
    const data = await this.getJson(
      `${API_PATHS.MARKET_ANALYST}/${encodeURIComponent(ticker)}`,
      params
    );
    const envelope = parseResponse(UnknownRowsEnvelopeSchema, data, "market analyst");
    const rowTicker = envelope.ticker ?? ticker.toUpperCase();
    return envelope.rows.map((row) => parseResponse(
      AnalystRowSchema,
      { ...row && typeof row === "object" ? row : {}, ticker: rowTicker },
      "analyst row"
    ));
  }
  async getInsider(ticker, opts) {
    const params = new URLSearchParams();
    if (opts?.from) params.set("from", opts.from);
    if (opts?.to) params.set("to", opts.to);
    const envelope = parseResponse(
      UnknownRowsEnvelopeSchema,
      await this.getJson(`${API_PATHS.MARKET_INSIDER}/${encodeURIComponent(ticker)}`, params),
      "market insider"
    );
    const rowTicker = envelope.ticker ?? ticker.toUpperCase();
    return envelope.rows.map((row) => parseResponse(
      InsiderReadRowSchema,
      { ...row && typeof row === "object" ? row : {}, ticker: rowTicker },
      "insider row"
    ));
  }
  async getShortVolume(ticker, opts) {
    const params = new URLSearchParams();
    if (opts?.from) params.set("from", opts.from);
    if (opts?.to) params.set("to", opts.to);
    const envelope = parseResponse(
      UnknownRowsEnvelopeSchema,
      await this.getJson(`${API_PATHS.MARKET_SHORT_VOLUME}/${encodeURIComponent(ticker)}`, params),
      "market short volume"
    );
    const rowTicker = envelope.ticker ?? ticker.toUpperCase();
    return envelope.rows.map((row) => parseResponse(
      ShortVolumeReadRowSchema,
      { ...row && typeof row === "object" ? row : {}, ticker: rowTicker },
      "short-volume row"
    ));
  }
  async getTransactions(query = {}) {
    const parsedQuery = TransactionsQuerySchema.parse(query);
    const params = new URLSearchParams();
    if (parsedQuery.since !== void 0) params.set("since", String(parsedQuery.since));
    if (parsedQuery.from) params.set("from", parsedQuery.from);
    if (parsedQuery.to) params.set("to", parsedQuery.to);
    if (parsedQuery.ticker) params.set("ticker", parsedQuery.ticker);
    if (parsedQuery.member) params.set("member", parsedQuery.member);
    if (parsedQuery.chamber) params.set("chamber", parsedQuery.chamber);
    if (parsedQuery.type) params.set("type", parsedQuery.type);
    if (parsedQuery.limit) params.set("limit", String(parsedQuery.limit));
    if (parsedQuery.order) params.set("order", parsedQuery.order);
    return parseResponse(
      TransactionsPageSchema,
      await this.getJson(API_PATHS.TRANSACTIONS, params),
      "transactions"
    );
  }
  async getTickerLeaderboard(opts = {}) {
    const params = new URLSearchParams();
    if (opts.window) params.set("window", opts.window);
    if (opts.limit) params.set("limit", String(opts.limit));
    return parseResponse(
      import_zod4.z.object({ tickers: import_zod4.z.array(TickerLeaderSchema) }),
      await this.getJson(API_PATHS.ANALYTICS_TICKER_LEADERBOARD, params),
      "ticker leaderboard"
    ).tickers;
  }
  async getClusterBuys(opts = {}) {
    const params = new URLSearchParams();
    if (opts.window) params.set("window", opts.window);
    if (opts.limit) params.set("limit", String(opts.limit));
    return parseResponse(
      import_zod4.z.object({ clusters: import_zod4.z.array(ClusterBuySchema) }),
      await this.getJson(API_PATHS.ANALYTICS_CLUSTER_BUYS, params),
      "cluster buys"
    ).clusters;
  }
  async getMemberLeaderboard(opts = {}) {
    const params = new URLSearchParams();
    if (opts.window) params.set("window", opts.window);
    if (opts.limit) params.set("limit", String(opts.limit));
    return parseResponse(
      import_zod4.z.object({ members: import_zod4.z.array(MemberLeaderSchema) }),
      await this.getJson(API_PATHS.ANALYTICS_MEMBER_LEADERBOARD, params),
      "member leaderboard"
    ).members;
  }
  async getMemberPerformance(filerId) {
    if (!filerId) return null;
    const data = parseResponse(
      import_zod4.z.object({ performance: MemberPerformanceSchema.nullable() }),
      await this.getJson(
        `${API_PATHS.ANALYTICS_MEMBER_PERFORMANCE}/${encodeURIComponent(filerId)}/performance`
      ),
      "member performance"
    );
    return data.performance;
  }
  async getConviction(opts = {}) {
    const params = new URLSearchParams();
    if (opts.window) params.set("window", opts.window);
    if (opts.limit) params.set("limit", String(opts.limit));
    return parseResponse(
      import_zod4.z.object({ tickers: import_zod4.z.array(ConvictionTickerSchema) }),
      await this.getJson(API_PATHS.ANALYTICS_CONVICTION, params),
      "conviction"
    ).tickers;
  }
  async getTickerBacktest(ticker, opts = {}) {
    const params = new URLSearchParams();
    if (opts.window) params.set("window", opts.window);
    if (opts.horizons) params.set("horizons", opts.horizons);
    if (opts.filerId) params.set("filerId", opts.filerId);
    const data = await this.getJson(
      `${API_PATHS.ANALYTICS_TICKER_BACKTEST}/${encodeURIComponent(ticker)}/backtest`,
      params
    );
    const parsed = parseResponse(TickerBacktestSchema, data, "ticker backtest");
    return parsed.horizons.length ? parsed : null;
  }
  async getConflicts(opts = {}) {
    const params = new URLSearchParams();
    if (opts.window) params.set("window", opts.window);
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.chamber) params.set("chamber", opts.chamber);
    if (opts.party) params.set("party", opts.party);
    return parseResponse(
      import_zod4.z.object({ conflicts: import_zod4.z.array(CommitteeConflictSchema) }),
      await this.getJson(API_PATHS.ANALYTICS_CONFLICTS, params),
      "committee conflicts"
    ).conflicts;
  }
};
var SseParser = class {
  buf = "";
  cur = { data: [] };
  lastEventId;
  atStart = true;
  swallowLeadingLf = false;
  eventDataLength = 0;
  maxLineLength;
  maxEventDataLength;
  constructor(options = {}) {
    this.maxLineLength = options.maxLineLength ?? 64 * 1024;
    this.maxEventDataLength = options.maxEventDataLength ?? 1024 * 1024;
    if (!Number.isInteger(this.maxLineLength) || this.maxLineLength <= 0) {
      throw new RangeError("maxLineLength must be a positive integer");
    }
    if (!Number.isInteger(this.maxEventDataLength) || this.maxEventDataLength <= 0) {
      throw new RangeError("maxEventDataLength must be a positive integer");
    }
  }
  resetAfterLimit(message) {
    this.buf = "";
    this.cur = { data: [] };
    this.lastEventId = void 0;
    this.atStart = true;
    this.swallowLeadingLf = false;
    this.eventDataLength = 0;
    throw new RangeError(message);
  }
  push(chunk) {
    if (this.swallowLeadingLf && chunk.length > 0) {
      if (chunk.startsWith("\n")) chunk = chunk.slice(1);
      this.swallowLeadingLf = false;
    }
    if (this.atStart && chunk.length > 0) {
      this.atStart = false;
      if (chunk.startsWith("\uFEFF")) chunk = chunk.slice(1);
    }
    this.buf += chunk;
    const out = [];
    for (; ; ) {
      const lf = this.buf.indexOf("\n");
      const cr = this.buf.indexOf("\r");
      const lineEnd = lf === -1 ? cr : cr === -1 ? lf : Math.min(lf, cr);
      if (lineEnd < 0) {
        if (this.buf.length > this.maxLineLength) {
          this.resetAfterLimit(`SSE line exceeds ${this.maxLineLength} characters`);
        }
        break;
      }
      if (lineEnd > this.maxLineLength) {
        this.resetAfterLimit(`SSE line exceeds ${this.maxLineLength} characters`);
      }
      const delimiter = this.buf[lineEnd];
      let delimiterLength = 1;
      if (delimiter === "\r") {
        if (this.buf[lineEnd + 1] === "\n") delimiterLength = 2;
        else if (lineEnd === this.buf.length - 1) this.swallowLeadingLf = true;
      }
      const line = this.buf.slice(0, lineEnd);
      this.buf = this.buf.slice(lineEnd + delimiterLength);
      if (line === "") {
        if (this.cur.data.length > 0) {
          const msg = { data: this.cur.data.join("\n") };
          if (this.cur.event !== void 0) msg.event = this.cur.event;
          if (this.lastEventId !== void 0) msg.id = this.lastEventId;
          out.push(msg);
        }
        this.cur = { data: [] };
        this.eventDataLength = 0;
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") {
        const separatorLength = this.cur.data.length > 0 ? 1 : 0;
        const nextLength = this.eventDataLength + separatorLength + value.length;
        if (nextLength > this.maxEventDataLength) {
          this.resetAfterLimit(`SSE event data exceeds ${this.maxEventDataLength} characters`);
        }
        this.cur.data.push(value);
        this.eventDataLength = nextLength;
      } else if (field === "event") this.cur.event = value || void 0;
      else if (field === "id" && !value.includes("\0")) this.lastEventId = value;
    }
    return out;
  }
};

// src/events.ts
function createCongressEvent(type, data, options) {
  const event = {
    ...options,
    type,
    emittedAt: options?.emittedAt ?? (/* @__PURE__ */ new Date()).toISOString()
  };
  if (data !== void 0) {
    event.data = data;
  }
  return CongressEventSchema.parse(event);
}

// src/brackets.ts
var STOCK_ACT_BRACKETS = Object.freeze([
  Object.freeze({ min: 1001, max: 15e3 }),
  Object.freeze({ min: 15001, max: 5e4 }),
  Object.freeze({ min: 50001, max: 1e5 }),
  Object.freeze({ min: 100001, max: 25e4 }),
  Object.freeze({ min: 250001, max: 5e5 }),
  Object.freeze({ min: 500001, max: 1e6 }),
  Object.freeze({ min: 1000001, max: 5e6 }),
  Object.freeze({ min: 5000001, max: 25e6 }),
  Object.freeze({ min: 25000001, max: 5e7 }),
  Object.freeze({ min: 50000001, max: null })
]);
function matchBracket(min, max) {
  for (const b of STOCK_ACT_BRACKETS) {
    if (b.min === min && b.max === max) return b;
  }
  return null;
}
function isValidBracket(min, max) {
  return matchBracket(min, max) !== null;
}
function nearestBracket(min, max) {
  if (!Number.isFinite(min) || min < 0) return null;
  if (max !== null && (!Number.isFinite(max) || max < min)) return null;
  const last = STOCK_ACT_BRACKETS[STOCK_ACT_BRACKETS.length - 1];
  if (max === null) {
    return min >= last.min - 1 ? last : null;
  }
  const lo = min;
  for (const b of STOCK_ACT_BRACKETS) {
    const top = b.max ?? Number.POSITIVE_INFINITY;
    if (lo >= b.min && lo <= top && max >= b.min && max <= top) return b;
  }
  if (lo >= last.min) return last;
  return null;
}

// src/operationGuard.ts
var import_zod5 = require("zod");
var OperationGuardRateLimitedSchema = import_zod5.z.object({
  code: import_zod5.z.literal("rate_limited"),
  operation: import_zod5.z.string().min(1),
  retryAfterSeconds: import_zod5.z.number().int().positive()
});
var OperationGuardInFlightSchema = import_zod5.z.object({
  code: import_zod5.z.literal("operation_in_flight"),
  operation: import_zod5.z.string().min(1),
  activeOperation: import_zod5.z.string().min(1)
});
var OperationGuardRejectionSchema = import_zod5.z.discriminatedUnion("code", [
  OperationGuardRateLimitedSchema,
  OperationGuardInFlightSchema
]);
function buildRateLimitedRejection(operation, retryAfterSeconds) {
  return OperationGuardRateLimitedSchema.parse({
    code: "rate_limited",
    operation,
    retryAfterSeconds
  });
}
function buildOperationInFlightRejection(operation, activeOperation) {
  return OperationGuardInFlightSchema.parse({
    code: "operation_in_flight",
    operation,
    activeOperation
  });
}
function getOperationGuardHttpStatus(rejection) {
  switch (rejection.code) {
    case "rate_limited":
      return 429;
    case "operation_in_flight":
      return 409;
  }
}

// src/webhookAuth.ts
function toHex(bytes) {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}
async function signCongressWebhook(body, secret) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(body));
  return toHex(new Uint8Array(sigBuf));
}
async function verifyCongressWebhookSignature(body, signatureHeader, secret) {
  const expectedSig = await signCongressWebhook(body, secret);
  let actualSig = signatureHeader.trim().toLowerCase();
  if (actualSig.startsWith("sha256=")) {
    actualSig = actualSig.slice(7);
  }
  if (expectedSig.length !== actualSig.length) return false;
  let isEqual = true;
  for (let i = 0; i < expectedSig.length; i++) {
    if (expectedSig[i] !== actualSig[i]) isEqual = false;
  }
  return isEqual;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  API_PATHS,
  API_USAGE_MONITOR_INGEST_PATH,
  APP_B_ORIGIN,
  APP_B_ORIGIN_TAG,
  AmountBracketSchema,
  AnalystRowSchema,
  AssetTypeCategorySchema,
  BacktestHorizonSchema,
  BundleResponseSchema,
  CONGRESS_EVENT_TYPES,
  CallClassifierContextSchema,
  ChamberSchema,
  ClientAssetSchema,
  ClientFilingSchema,
  ClientMemberSchema,
  ClientTradeSchema,
  ClientTransactionSchema,
  ClusterBuySchema,
  CommitteeConflictSchema,
  CongressEventSchema,
  CongressEventTypeSchema,
  CongressTradeClient,
  CongressTradeHttpError,
  CongressTransactionReadSchema,
  CongressTransactionSchema,
  ConvictionTickerSchema,
  DEFAULT_CONGRESS_TRADE_BASE_URL,
  DEFAULT_TRANSACTIONS_LIMIT,
  FundamentalRowSchema,
  InsiderReadRowSchema,
  InsiderRowSchema,
  IsoDateSchema,
  LAG_BUCKETS,
  MAX_REFS_BATCH,
  MKT_CAP_THRESHOLDS,
  MemberLeaderSchema,
  MemberPerformanceSchema,
  MktCapBucketSchema,
  OperationGuardInFlightSchema,
  OperationGuardRateLimitedSchema,
  OperationGuardRejectionSchema,
  OwnerSchema,
  PartyBucketSchema,
  PriceCloseSchema,
  PriceSeriesSchema,
  STOCK_ACT_BRACKETS,
  SecurityRefInputSchema,
  SecurityRefSchema,
  SharePayloadSchema,
  ShortVolumeReadRowSchema,
  ShortVolumeRowSchema,
  SnapshotManifestSchema,
  SnapshotTableInfoSchema,
  SseMessageSchema,
  SseParser,
  SubscriptionSchema,
  TICKER_ACQUISITIONS,
  TICKER_ALIASES,
  TICKER_RENAMES,
  TickerBacktestSchema,
  TickerLeaderSchema,
  TransactionsPageSchema,
  TransactionsQuerySchema,
  TxTypeSchema,
  UsageTelemetryBatchSchema,
  UsageTelemetryBillingModeSchema,
  UsageTelemetryConfidenceSchema,
  UsageTelemetryEventSchema,
  UsageTelemetryIngestResponseSchema,
  UsageTelemetryLimitWindowSchema,
  UsageTelemetryMetadataSchema,
  UsageTelemetryMetricTypeSchema,
  UsageTelemetryUnitSchema,
  WELL_FORMED_TICKER,
  WINDOW_PRESETS,
  bracketMidpoint,
  buildCallClassifier,
  buildOperationInFlightRejection,
  buildRateLimitedRejection,
  classifyTickerAlias,
  clean,
  createCongressEvent,
  createUsageTelemetryClient,
  daysBetween,
  deriveUsageTelemetryIdempotencyKey,
  getOperationGuardHttpStatus,
  isIsoDate,
  isPlaceholderTicker,
  isValidBracket,
  isWellFormedTicker,
  marketCapBucket,
  matchBracket,
  mergeRefs,
  nearestBracket,
  normalizePreferredTickerVariant,
  normalizeSecurityRef,
  normalizeTicker,
  openrouterRequestEnrichment,
  parseArray,
  parseSafe,
  punctuationVariants,
  resolveContinuousTicker,
  resolvePreferredTickerFromAssetName,
  resolveTickerAlias,
  resolveTickerDeterministic,
  signCongressWebhook,
  stripPreferredSeries,
  telemetryEventClassifier,
  usageMonitorIngestUrl,
  verifyCongressWebhookSignature
});
