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
import { z } from "zod";

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
var nullAsUndefined = (schema) => z.preprocess((value) => value === null ? void 0 : value, schema.optional());
var IsoDateSchema = z.string().refine(isIsoDate, {
  message: "Expected a valid YYYY-MM-DD date"
});
var ChamberSchema = z.enum(["house", "senate", "executive"]);
var PartyBucketSchema = z.enum(["D", "R", "O"]);
var OwnerSchema = z.enum(["self", "spouse", "joint", "dependent"]);
var TxTypeSchema = z.enum(["P", "S", "E"]);
var AssetTypeCategorySchema = z.enum([
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
var MktCapBucketSchema = z.enum([
  "mega",
  "large",
  "mid",
  "small",
  "micro",
  "nano"
]);
var PriceCloseSchema = z.object({
  date: IsoDateSchema,
  close: z.number(),
  volume: nullAsUndefined(z.number())
});
var SecurityRefSchema = z.object({
  ticker: z.string().min(1).max(20),
  companyName: z.string().nullable(),
  sector: z.string().nullable(),
  industry: z.string().nullable(),
  assetClass: z.string().nullable(),
  isEtf: z.boolean(),
  isAdr: z.boolean(),
  country: z.string().nullable(),
  stateHq: z.string().nullable(),
  stateOfIncorp: z.string().nullable(),
  exchange: z.string().nullable(),
  exchangeShort: z.string().nullable(),
  currency: z.string().nullable(),
  marketCap: z.number().nullable(),
  marketCapBucket: MktCapBucketSchema.nullable(),
  sharesOutstanding: z.number().nullable(),
  ipoDate: z.string().nullable(),
  cik: z.string().nullable(),
  sicCode: z.string().nullable(),
  sicDescription: z.string().nullable(),
  source: z.string().nullable(),
  enrichedAt: z.string().nullable().optional(),
  currentPrice: z.number().nullable().optional(),
  currentPriceDate: IsoDateSchema.nullable().optional()
});
var SecurityRefInputSchema = SecurityRefSchema.partial().extend({
  ticker: z.string().min(1).max(20)
});
var CongressTransactionSchema = z.object({
  id: z.string().min(1),
  docId: z.string().min(1),
  filerId: z.string().nullable(),
  txDate: z.string().nullable(),
  owner: OwnerSchema.nullable(),
  assetName: z.string(),
  ticker: z.string().nullable(),
  assetType: z.string().nullable(),
  assetTypeName: z.string().nullable().optional(),
  assetTypeCategory: AssetTypeCategorySchema.nullable().optional(),
  assetTypeCategoryLabel: z.string().nullable().optional(),
  txType: TxTypeSchema,
  amountMin: z.number().nullable(),
  amountMax: z.number().nullable(),
  estValue: z.number().nullable().optional(),
  isOption: z.boolean(),
  capGainsOver200: z.boolean(),
  rawText: z.string(),
  filingStatus: z.string().nullable().optional(),
  subholding: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  supplementalText: z.string().nullable().optional(),
  confidence: z.number().optional(),
  source: z.enum(["primary", "seed_dataset", "manual"]).optional(),
  rowKey: z.string().nullable().optional(),
  createdAt: z.string().optional(),
  cursorSeq: z.number().int().nonnegative().optional(),
  chamber: ChamberSchema.nullable().optional(),
  memberName: z.string().nullable().optional(),
  filedDate: z.string().nullable().optional(),
  fullName: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  photoUrl: z.string().nullable().optional(),
  firstSeenAt: z.string().nullable().optional(),
  sourceUrl: z.string().nullable().optional(),
  refCompanyName: z.string().nullable().optional(),
  refSector: z.string().nullable().optional(),
  refMarketCap: z.number().nullable().optional(),
  refMarketCapBucket: z.string().nullable().optional(),
  refCountry: z.string().nullable().optional(),
  refExchangeShort: z.string().nullable().optional(),
  refAssetClass: z.string().nullable().optional()
});
var CongressTransactionReadSchema = CongressTransactionSchema.extend({
  confidence: z.number(),
  source: z.enum(["primary", "seed_dataset", "manual"]),
  createdAt: z.string(),
  cursorSeq: z.number().int().nonnegative()
});
var TransactionsPageSchema = z.object({
  transactions: z.array(CongressTransactionReadSchema),
  cursor: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative().optional(),
  filingsImportedToday: z.number().int().nonnegative().optional()
});
var TransactionsQuerySchema = z.object({
  since: z.union([
    z.string().regex(/^\d+$/, "Expected a non-negative integer cursor"),
    z.number().int().nonnegative()
  ]).optional(),
  from: IsoDateSchema.optional(),
  to: IsoDateSchema.optional(),
  ticker: z.string().optional(),
  member: z.string().optional(),
  chamber: ChamberSchema.optional(),
  type: TxTypeSchema.optional(),
  limit: z.number().int().positive().optional(),
  order: z.enum(["asc", "desc"]).optional()
});
var FundamentalRowSchema = z.object({
  ticker: z.string(),
  date: IsoDateSchema,
  peRatio: nullAsUndefined(z.number()),
  eps: nullAsUndefined(z.number()),
  beta: nullAsUndefined(z.number()),
  dividendYield: nullAsUndefined(z.number()),
  week52High: nullAsUndefined(z.number()),
  week52Low: nullAsUndefined(z.number()),
  fcfYield: nullAsUndefined(z.number()),
  debtToEquity: nullAsUndefined(z.number()),
  epsGrowth: nullAsUndefined(z.number()),
  source: nullAsUndefined(z.string()),
  updatedAt: z.string().optional()
});
var AnalystRowSchema = z.object({
  ticker: z.string(),
  date: IsoDateSchema,
  rating: nullAsUndefined(z.string()),
  strongBuy: nullAsUndefined(z.number()),
  buy: nullAsUndefined(z.number()),
  hold: nullAsUndefined(z.number()),
  sell: nullAsUndefined(z.number()),
  strongSell: nullAsUndefined(z.number()),
  targetMean: nullAsUndefined(z.number()),
  targetHigh: nullAsUndefined(z.number()),
  targetLow: nullAsUndefined(z.number()),
  targetMedian: nullAsUndefined(z.number()),
  analystCount: nullAsUndefined(z.number()),
  source: nullAsUndefined(z.string()),
  updatedAt: z.string().optional()
});
var InsiderRowSchema = z.object({
  ticker: z.string(),
  date: IsoDateSchema,
  sentiment: z.number(),
  buyFilings: z.number(),
  sellFilings: z.number(),
  buyShares: z.number(),
  sellShares: z.number(),
  owners: z.array(z.string())
});
var InsiderReadRowSchema = InsiderRowSchema.extend({
  sentiment: z.number().nullable(),
  buyFilings: z.number().nullable(),
  sellFilings: z.number().nullable(),
  buyShares: z.number().nullable(),
  sellShares: z.number().nullable()
});
var ShortVolumeRowSchema = z.object({
  ticker: z.string(),
  date: IsoDateSchema,
  ratio: z.number(),
  elevated: z.boolean()
});
var ShortVolumeReadRowSchema = ShortVolumeRowSchema.extend({
  ratio: z.number().nullable()
});
var PriceSeriesSchema = z.object({
  ticker: z.string(),
  closes: z.array(PriceCloseSchema),
  currentPrice: nullAsUndefined(z.number()),
  currentPriceDate: nullAsUndefined(IsoDateSchema)
});
var SharePayloadSchema = z.object({
  refs: z.array(SecurityRefInputSchema).optional(),
  spx: z.array(PriceCloseSchema).optional(),
  prices: z.array(PriceSeriesSchema).optional(),
  insider: z.array(InsiderRowSchema).optional(),
  shortVolume: z.array(ShortVolumeRowSchema).optional(),
  fundamentals: z.array(FundamentalRowSchema).optional(),
  analyst: z.array(AnalystRowSchema).optional(),
  origin: z.string().optional()
});
var BundleResponseSchema = z.object({
  ticker: z.string(),
  ref: SecurityRefSchema.nullable(),
  prices: PriceSeriesSchema.nullable(),
  spx: z.array(PriceCloseSchema)
});
var CongressEventTypeSchema = z.enum(CONGRESS_EVENT_TYPES);
var CongressEventSchema = z.object({
  type: CongressEventTypeSchema.or(z.string().trim().min(1)),
  id: z.string().trim().min(1).optional(),
  seq: z.number().int().nonnegative().optional(),
  emittedAt: z.string().datetime().optional(),
  data: z.unknown().optional()
});
var ConvictionTickerSchema = z.object({
  ticker: z.string(),
  name: nullAsUndefined(z.string()),
  convictionScore: z.number().nullable(),
  direction: z.enum(["BUY", "SELL"]).nullable(),
  fallback: z.boolean().optional(),
  memberCount: z.number().optional(),
  tradeCount: z.number().optional(),
  directionalMembers: z.number().optional(),
  directionalTrades: z.number().optional(),
  netSentiment: z.number().optional(),
  estNetFlowUsd: z.number().optional(),
  parties: z.record(z.string(), z.number()).optional(),
  components: z.record(z.string(), z.unknown()).optional()
});
var TickerLeaderSchema = z.object({
  ticker: z.string(),
  name: nullAsUndefined(z.string()),
  tradeCount: z.number().optional(),
  buyCount: z.number().optional(),
  sellCount: z.number().optional(),
  memberCount: z.number().optional(),
  estVolumeUsd: z.number().optional(),
  estNetFlowUsd: z.number().optional(),
  netSentiment: z.number().optional()
});
var ClusterBuySchema = z.object({
  ticker: nullAsUndefined(z.string()),
  name: nullAsUndefined(z.string()),
  txType: nullAsUndefined(z.string()),
  memberCount: z.number().optional(),
  tradeCount: z.number().optional(),
  estVolumeUsd: z.number().optional(),
  firstSeen: nullAsUndefined(z.string()),
  lastSeen: nullAsUndefined(z.string()),
  parties: z.record(z.string(), z.number()).optional(),
  topMembers: z.array(z.object({
    filerId: nullAsUndefined(z.string()),
    fullName: nullAsUndefined(z.string()),
    memberName: nullAsUndefined(z.string()),
    name: nullAsUndefined(z.string()),
    partyBucket: PartyBucketSchema.nullable().optional(),
    photoUrl: nullAsUndefined(z.string()),
    tradeCount: z.number().optional()
  })).optional()
});
var MemberLeaderSchema = z.object({
  filerId: nullAsUndefined(z.string()),
  fullName: nullAsUndefined(z.string()),
  memberName: nullAsUndefined(z.string()),
  name: nullAsUndefined(z.string()),
  party: nullAsUndefined(z.string()),
  partyBucket: PartyBucketSchema.nullable().optional(),
  chamber: ChamberSchema.nullable().optional(),
  state: nullAsUndefined(z.string()),
  photoUrl: nullAsUndefined(z.string()),
  tradeCount: z.number().optional(),
  buyCount: z.number().optional(),
  sellCount: z.number().optional(),
  uniqueTickers: z.number().optional(),
  estVolumeUsd: z.number().optional(),
  estNetFlowUsd: z.number().optional(),
  netSentiment: z.number().optional()
});
var MemberPerformanceSchema = z.object({
  tradeCount: z.number().optional(),
  scoredCount: z.number().optional(),
  winRate: z.number().nullable().optional(),
  medianReturn: z.number().nullable().optional(),
  medianExcess: z.number().nullable().optional(),
  avgReturn: z.number().nullable().optional(),
  avgExcess: z.number().nullable().optional()
});
var BacktestHorizonSchema = z.object({
  days: z.number(),
  tradeCount: z.number(),
  n: z.number(),
  medianReturn: z.number().nullable(),
  avgReturn: z.number().nullable(),
  winRate: z.number().nullable(),
  medianExcess: z.number().nullable(),
  avgExcess: z.number().nullable()
});
var TickerBacktestSchema = z.object({
  ticker: z.string(),
  filerId: z.string().nullable().optional(),
  txType: z.string(),
  totalBuyEvents: z.number(),
  pricedDays: z.number(),
  horizons: z.array(BacktestHorizonSchema)
});
var CommitteeConflictSchema = z.object({
  id: z.string().nullable(),
  ticker: z.string().nullable(),
  sector: z.string(),
  txType: z.string().nullable(),
  txDate: z.string().nullable(),
  filerId: z.string().nullable(),
  memberName: z.string().nullable(),
  chamber: z.string().nullable(),
  partyBucket: PartyBucketSchema.nullable(),
  viaCommittees: z.array(z.string()),
  estAmountUsd: z.number()
});
var SnapshotTableInfoSchema = z.object({
  objectKey: z.string(),
  rowCount: z.number()
});
var SnapshotManifestSchema = z.object({
  generatedAt: z.string(),
  snapshotDate: IsoDateSchema,
  runId: z.string(),
  format: z.literal("ndjson"),
  tables: z.record(z.string(), SnapshotTableInfoSchema),
  schema: z.record(z.string(), z.array(z.string()))
});
var ClientMemberSchema = z.object({
  id: z.string().nullable(),
  name: z.string().nullable(),
  chamber: ChamberSchema.nullable(),
  party: z.string().nullable(),
  state: z.string().nullable(),
  photoUrl: z.string().nullable()
});
var ClientAssetSchema = z.object({
  name: z.string(),
  ticker: z.string().nullable(),
  type: z.string().nullable(),
  sector: z.string().nullable(),
  marketCapBucket: z.string().nullable(),
  companyName: z.string().nullable().optional(),
  logoUrl: z.string().nullable().optional(),
  typeName: z.string().nullable().optional(),
  typeCategory: z.string().nullable().optional(),
  typeCategoryLabel: z.string().nullable().optional()
});
var ClientTransactionSchema = z.object({
  date: z.string().nullable(),
  type: TxTypeSchema,
  owner: z.string().nullable(),
  amountMin: z.number().nullable(),
  amountMax: z.number().nullable(),
  estValue: z.number().nullable().optional(),
  isOption: z.boolean()
});
var ClientFilingSchema = z.object({
  filedDate: z.string().nullable(),
  firstSeenAt: z.string().nullable(),
  sourceUrl: z.string().nullable()
});
var ClientTradeSchema = z.object({
  id: z.string(),
  cursor: z.number(),
  docId: z.string(),
  member: ClientMemberSchema,
  asset: ClientAssetSchema,
  transaction: ClientTransactionSchema,
  filing: ClientFilingSchema,
  confidence: z.number(),
  source: z.enum(["primary", "seed_dataset", "manual"])
});
var AmountBracketSchema = z.object({
  min: z.number().finite().nonnegative(),
  max: z.number().finite().nonnegative().nullable()
}).refine((data) => data.max === null || data.max >= data.min, {
  message: "max must be greater than or equal to min",
  path: ["max"]
});
var SubscriptionSchema = z.object({
  id: z.string().min(1),
  secret: z.string().min(16).max(256),
  streamUrl: z.string().optional()
});
var SseMessageSchema = z.object({
  event: z.string().optional(),
  id: z.string().optional(),
  data: z.string()
});
function parseArray(schema, data) {
  const result = z.array(schema).safeParse(data);
  return result.success ? result.data : null;
}
function parseSafe(schema, data) {
  const result = schema.safeParse(data);
  return result.success ? result.data : null;
}

// src/usageTelemetry.ts
import { z as z2 } from "zod";
var UsageTelemetryMetricTypeSchema = z2.enum([
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
var UsageTelemetryUnitSchema = z2.enum([
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
var UsageTelemetryBillingModeSchema = z2.enum([
  "actual",
  "estimated",
  "manual"
]);
var UsageTelemetryConfidenceSchema = z2.enum([
  "actual",
  "estimated",
  "manual"
]);
var UsageTelemetryLimitWindowSchema = z2.enum([
  "minute",
  "day",
  "month",
  "run"
]);
var UsageTelemetryMetadataSchema = z2.record(
  z2.string(),
  z2.union([z2.string(), z2.number().finite(), z2.boolean(), z2.null()])
).transform((metadata) => {
  const clean2 = {};
  for (const [rawKey, rawValue] of Object.entries(metadata).slice(0, 50)) {
    const key = rawKey.trim().slice(0, 80);
    if (!key) continue;
    clean2[key] = typeof rawValue === "string" ? rawValue.slice(0, 500) : rawValue;
  }
  return clean2;
});
var UsageTelemetryEventSchema = z2.object({
  sourceApp: z2.string().trim().min(1).max(80),
  environment: z2.string().trim().min(1).max(80).optional(),
  provider: z2.string().trim().min(1).max(80),
  service: z2.string().trim().min(1).max(120).optional(),
  // Per-project attribution name. Resolved to Project.id on the monitor at
  // ingest. Deliberately NOT part of the idempotency basis — adding it there
  // would rekey existing events.
  project: z2.string().trim().min(1).max(120).optional(),
  label: z2.string().trim().min(1).max(160).optional(),
  keyRef: z2.string().trim().min(1).max(160).optional(),
  billingMode: UsageTelemetryBillingModeSchema.default("estimated"),
  metricType: UsageTelemetryMetricTypeSchema.default("usage"),
  quantity: z2.number().finite().nonnegative().optional(),
  unit: UsageTelemetryUnitSchema.optional(),
  costUsd: z2.number().finite().nonnegative().optional(),
  requests: z2.number().int().nonnegative().optional(),
  credits: z2.number().finite().nonnegative().optional(),
  limit: z2.number().finite().nonnegative().optional(),
  limitWindow: UsageTelemetryLimitWindowSchema.optional(),
  tier: z2.string().trim().min(1).max(80).optional(),
  confidence: UsageTelemetryConfidenceSchema.default("estimated"),
  windowStart: z2.string().datetime().optional(),
  windowEnd: z2.string().datetime().optional(),
  occurredAt: z2.string().datetime().optional(),
  // The provider-side call/generation id (e.g. OpenRouter's `id` on a
  // completions response), pushed so the monitor can verify reported cost
  // against the provider's own record (e.g. `GET /api/v1/generation?id=...`).
  // CONTRACT: deliberately NOT part of `deriveUsageTelemetryIdempotencyKey`'s
  // basis — adding it there would change the key for existing/replayed
  // events. Keep the idempotency key derivation limited to sourceApp,
  // provider, metricType, keyRef, and occurredAt.
  providerRequestId: z2.string().trim().min(1).max(200).optional(),
  metadata: UsageTelemetryMetadataSchema.optional(),
  idempotencyKey: z2.string().trim().min(1).max(200).optional()
});
var UsageTelemetryBatchSchema = z2.object({
  events: z2.array(UsageTelemetryEventSchema).min(1).max(100)
});
var UsageTelemetryIngestResponseSchema = z2.object({
  ok: z2.boolean(),
  accepted: z2.number().int().nonnegative(),
  ignoredPruned: z2.number().int().nonnegative().optional()
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
import { z as z3 } from "zod";
var dynamicIdSchema = z3.string().trim().max(128).transform((value) => value === "" ? void 0 : value).optional();
var CallClassifierContextSchema = z3.object({
  /** Producer app identifier, e.g. "congress-trade" or "socratic-trade". */
  sourceApp: z3.string().trim().min(1).max(80),
  /** Deploy environment, e.g. "production" | "staging" | "development". */
  environment: z3.string().trim().min(1).max(80).optional(),
  /** Logical service/subsystem within the app, e.g. "extraction-worker". */
  service: z3.string().trim().min(1).max(120).optional(),
  /** Finer-grained feature/call-site tag, e.g. "openrouter-vision-extract". */
  feature: z3.string().trim().min(1).max(120).optional(),
  /** Reference to the API key used (name/alias, never the raw secret). */
  keyRef: z3.string().trim().min(1).max(160).optional(),
  /** Deployed commit SHA or version tag for the calling build. */
  gitSha: z3.string().trim().min(1).max(80).optional(),
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
import { z as z4 } from "zod";
var RawRefEnvelopeSchema = z4.object({ ref: z4.unknown().nullable() });
var RawRefsEnvelopeSchema = z4.object({ refs: z4.array(z4.unknown()) });
var ClosesEnvelopeSchema = z4.object({ closes: z4.array(PriceCloseSchema) });
var UnknownRowsEnvelopeSchema = z4.object({
  ticker: z4.string().optional(),
  rows: z4.array(z4.unknown())
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
      z4.object({ tickers: z4.array(TickerLeaderSchema) }),
      await this.getJson(API_PATHS.ANALYTICS_TICKER_LEADERBOARD, params),
      "ticker leaderboard"
    ).tickers;
  }
  async getClusterBuys(opts = {}) {
    const params = new URLSearchParams();
    if (opts.window) params.set("window", opts.window);
    if (opts.limit) params.set("limit", String(opts.limit));
    return parseResponse(
      z4.object({ clusters: z4.array(ClusterBuySchema) }),
      await this.getJson(API_PATHS.ANALYTICS_CLUSTER_BUYS, params),
      "cluster buys"
    ).clusters;
  }
  async getMemberLeaderboard(opts = {}) {
    const params = new URLSearchParams();
    if (opts.window) params.set("window", opts.window);
    if (opts.limit) params.set("limit", String(opts.limit));
    return parseResponse(
      z4.object({ members: z4.array(MemberLeaderSchema) }),
      await this.getJson(API_PATHS.ANALYTICS_MEMBER_LEADERBOARD, params),
      "member leaderboard"
    ).members;
  }
  async getMemberPerformance(filerId) {
    if (!filerId) return null;
    const data = parseResponse(
      z4.object({ performance: MemberPerformanceSchema.nullable() }),
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
      z4.object({ tickers: z4.array(ConvictionTickerSchema) }),
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
      z4.object({ conflicts: z4.array(CommitteeConflictSchema) }),
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
import { z as z5 } from "zod";
var OperationGuardRateLimitedSchema = z5.object({
  code: z5.literal("rate_limited"),
  operation: z5.string().min(1),
  retryAfterSeconds: z5.number().int().positive()
});
var OperationGuardInFlightSchema = z5.object({
  code: z5.literal("operation_in_flight"),
  operation: z5.string().min(1),
  activeOperation: z5.string().min(1)
});
var OperationGuardRejectionSchema = z5.discriminatedUnion("code", [
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
export {
  API_PATHS,
  API_USAGE_MONITOR_INGEST_PATH,
  APP_B_ORIGIN_TAG as APP_B_ORIGIN,
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
};
