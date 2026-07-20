import { z } from 'zod';

declare const IsoDateSchema: z.ZodString;
declare const ChamberSchema: z.ZodEnum<{
    house: "house";
    senate: "senate";
    executive: "executive";
}>;
type Chamber = z.infer<typeof ChamberSchema>;
declare const PartyBucketSchema: z.ZodEnum<{
    D: "D";
    R: "R";
    O: "O";
}>;
type PartyBucket = z.infer<typeof PartyBucketSchema>;
declare const OwnerSchema: z.ZodEnum<{
    self: "self";
    spouse: "spouse";
    joint: "joint";
    dependent: "dependent";
}>;
type Owner = z.infer<typeof OwnerSchema>;
declare const TxTypeSchema: z.ZodEnum<{
    P: "P";
    S: "S";
    E: "E";
}>;
type TxType = z.infer<typeof TxTypeSchema>;
declare const AssetTypeCategorySchema: z.ZodEnum<{
    public_equity: "public_equity";
    private_equity: "private_equity";
    option: "option";
    fund: "fund";
    fixed_income_government: "fixed_income_government";
    fixed_income_corporate: "fixed_income_corporate";
    fixed_income_asset_backed: "fixed_income_asset_backed";
    cash: "cash";
    retirement_or_529: "retirement_or_529";
    real_estate: "real_estate";
    private_fund: "private_fund";
    business_interest: "business_interest";
    crypto: "crypto";
    insurance_annuity: "insurance_annuity";
    trust: "trust";
    commodity_collectible: "commodity_collectible";
    derivative: "derivative";
    intellectual_property: "intellectual_property";
    receivable: "receivable";
    other_security: "other_security";
    other: "other";
    unknown: "unknown";
}>;
type AssetTypeCategory = z.infer<typeof AssetTypeCategorySchema>;
declare const MktCapBucketSchema: z.ZodEnum<{
    mega: "mega";
    large: "large";
    mid: "mid";
    small: "small";
    micro: "micro";
    nano: "nano";
}>;
type MktCapBucket = z.infer<typeof MktCapBucketSchema>;
declare const PriceCloseSchema: z.ZodObject<{
    date: z.ZodString;
    close: z.ZodNumber;
    volume: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
}, z.core.$strip>;
type PriceClose = z.infer<typeof PriceCloseSchema>;
declare const SecurityRefSchema: z.ZodObject<{
    ticker: z.ZodString;
    companyName: z.ZodNullable<z.ZodString>;
    sector: z.ZodNullable<z.ZodString>;
    industry: z.ZodNullable<z.ZodString>;
    assetClass: z.ZodNullable<z.ZodString>;
    isEtf: z.ZodBoolean;
    isAdr: z.ZodBoolean;
    country: z.ZodNullable<z.ZodString>;
    stateHq: z.ZodNullable<z.ZodString>;
    stateOfIncorp: z.ZodNullable<z.ZodString>;
    exchange: z.ZodNullable<z.ZodString>;
    exchangeShort: z.ZodNullable<z.ZodString>;
    currency: z.ZodNullable<z.ZodString>;
    marketCap: z.ZodNullable<z.ZodNumber>;
    marketCapBucket: z.ZodNullable<z.ZodEnum<{
        mega: "mega";
        large: "large";
        mid: "mid";
        small: "small";
        micro: "micro";
        nano: "nano";
    }>>;
    sharesOutstanding: z.ZodNullable<z.ZodNumber>;
    ipoDate: z.ZodNullable<z.ZodString>;
    cik: z.ZodNullable<z.ZodString>;
    sicCode: z.ZodNullable<z.ZodString>;
    sicDescription: z.ZodNullable<z.ZodString>;
    source: z.ZodNullable<z.ZodString>;
    enrichedAt: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    currentPrice: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    currentPriceDate: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$strip>;
type SecurityRef = z.infer<typeof SecurityRefSchema>;
declare const SecurityRefInputSchema: z.ZodObject<{
    companyName: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    sector: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    industry: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    assetClass: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    isEtf: z.ZodOptional<z.ZodBoolean>;
    isAdr: z.ZodOptional<z.ZodBoolean>;
    country: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    stateHq: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    stateOfIncorp: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    exchange: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    exchangeShort: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    currency: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    marketCap: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    marketCapBucket: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
        mega: "mega";
        large: "large";
        mid: "mid";
        small: "small";
        micro: "micro";
        nano: "nano";
    }>>>;
    sharesOutstanding: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    ipoDate: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    cik: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    sicCode: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    sicDescription: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    source: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    enrichedAt: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
    currentPrice: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodNumber>>>;
    currentPriceDate: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
    ticker: z.ZodString;
}, z.core.$strip>;
type SecurityRefInput = z.infer<typeof SecurityRefInputSchema>;
declare const CongressTransactionSchema: z.ZodObject<{
    id: z.ZodString;
    docId: z.ZodString;
    filerId: z.ZodNullable<z.ZodString>;
    txDate: z.ZodNullable<z.ZodString>;
    owner: z.ZodNullable<z.ZodEnum<{
        self: "self";
        spouse: "spouse";
        joint: "joint";
        dependent: "dependent";
    }>>;
    assetName: z.ZodString;
    ticker: z.ZodNullable<z.ZodString>;
    assetType: z.ZodNullable<z.ZodString>;
    assetTypeName: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    assetTypeCategory: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
        public_equity: "public_equity";
        private_equity: "private_equity";
        option: "option";
        fund: "fund";
        fixed_income_government: "fixed_income_government";
        fixed_income_corporate: "fixed_income_corporate";
        fixed_income_asset_backed: "fixed_income_asset_backed";
        cash: "cash";
        retirement_or_529: "retirement_or_529";
        real_estate: "real_estate";
        private_fund: "private_fund";
        business_interest: "business_interest";
        crypto: "crypto";
        insurance_annuity: "insurance_annuity";
        trust: "trust";
        commodity_collectible: "commodity_collectible";
        derivative: "derivative";
        intellectual_property: "intellectual_property";
        receivable: "receivable";
        other_security: "other_security";
        other: "other";
        unknown: "unknown";
    }>>>;
    assetTypeCategoryLabel: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    txType: z.ZodEnum<{
        P: "P";
        S: "S";
        E: "E";
    }>;
    amountMin: z.ZodNullable<z.ZodNumber>;
    amountMax: z.ZodNullable<z.ZodNumber>;
    estValue: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    isOption: z.ZodBoolean;
    capGainsOver200: z.ZodBoolean;
    rawText: z.ZodString;
    filingStatus: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    subholding: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    location: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    supplementalText: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    confidence: z.ZodOptional<z.ZodNumber>;
    source: z.ZodOptional<z.ZodEnum<{
        primary: "primary";
        seed_dataset: "seed_dataset";
        manual: "manual";
    }>>;
    rowKey: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    createdAt: z.ZodOptional<z.ZodString>;
    cursorSeq: z.ZodOptional<z.ZodNumber>;
    chamber: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
        house: "house";
        senate: "senate";
        executive: "executive";
    }>>>;
    memberName: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    filedDate: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    fullName: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    state: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    photoUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    firstSeenAt: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    sourceUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    refCompanyName: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    refSector: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    refMarketCap: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    refMarketCapBucket: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    refCountry: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    refExchangeShort: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    refAssetClass: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$strip>;
type CongressTransaction = z.infer<typeof CongressTransactionSchema>;
/** Full transaction row returned by the cursor-paginated REST read endpoint. */
declare const CongressTransactionReadSchema: z.ZodObject<{
    id: z.ZodString;
    docId: z.ZodString;
    filerId: z.ZodNullable<z.ZodString>;
    txDate: z.ZodNullable<z.ZodString>;
    owner: z.ZodNullable<z.ZodEnum<{
        self: "self";
        spouse: "spouse";
        joint: "joint";
        dependent: "dependent";
    }>>;
    assetName: z.ZodString;
    ticker: z.ZodNullable<z.ZodString>;
    assetType: z.ZodNullable<z.ZodString>;
    assetTypeName: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    assetTypeCategory: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
        public_equity: "public_equity";
        private_equity: "private_equity";
        option: "option";
        fund: "fund";
        fixed_income_government: "fixed_income_government";
        fixed_income_corporate: "fixed_income_corporate";
        fixed_income_asset_backed: "fixed_income_asset_backed";
        cash: "cash";
        retirement_or_529: "retirement_or_529";
        real_estate: "real_estate";
        private_fund: "private_fund";
        business_interest: "business_interest";
        crypto: "crypto";
        insurance_annuity: "insurance_annuity";
        trust: "trust";
        commodity_collectible: "commodity_collectible";
        derivative: "derivative";
        intellectual_property: "intellectual_property";
        receivable: "receivable";
        other_security: "other_security";
        other: "other";
        unknown: "unknown";
    }>>>;
    assetTypeCategoryLabel: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    txType: z.ZodEnum<{
        P: "P";
        S: "S";
        E: "E";
    }>;
    amountMin: z.ZodNullable<z.ZodNumber>;
    amountMax: z.ZodNullable<z.ZodNumber>;
    estValue: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    isOption: z.ZodBoolean;
    capGainsOver200: z.ZodBoolean;
    rawText: z.ZodString;
    filingStatus: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    subholding: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    location: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    supplementalText: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    rowKey: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    chamber: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
        house: "house";
        senate: "senate";
        executive: "executive";
    }>>>;
    memberName: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    filedDate: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    fullName: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    state: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    photoUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    firstSeenAt: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    sourceUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    refCompanyName: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    refSector: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    refMarketCap: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    refMarketCapBucket: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    refCountry: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    refExchangeShort: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    refAssetClass: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    confidence: z.ZodNumber;
    source: z.ZodEnum<{
        primary: "primary";
        seed_dataset: "seed_dataset";
        manual: "manual";
    }>;
    createdAt: z.ZodString;
    cursorSeq: z.ZodNumber;
}, z.core.$strip>;
type CongressTransactionRead = z.infer<typeof CongressTransactionReadSchema>;
declare const TransactionsPageSchema: z.ZodObject<{
    transactions: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        docId: z.ZodString;
        filerId: z.ZodNullable<z.ZodString>;
        txDate: z.ZodNullable<z.ZodString>;
        owner: z.ZodNullable<z.ZodEnum<{
            self: "self";
            spouse: "spouse";
            joint: "joint";
            dependent: "dependent";
        }>>;
        assetName: z.ZodString;
        ticker: z.ZodNullable<z.ZodString>;
        assetType: z.ZodNullable<z.ZodString>;
        assetTypeName: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        assetTypeCategory: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
            public_equity: "public_equity";
            private_equity: "private_equity";
            option: "option";
            fund: "fund";
            fixed_income_government: "fixed_income_government";
            fixed_income_corporate: "fixed_income_corporate";
            fixed_income_asset_backed: "fixed_income_asset_backed";
            cash: "cash";
            retirement_or_529: "retirement_or_529";
            real_estate: "real_estate";
            private_fund: "private_fund";
            business_interest: "business_interest";
            crypto: "crypto";
            insurance_annuity: "insurance_annuity";
            trust: "trust";
            commodity_collectible: "commodity_collectible";
            derivative: "derivative";
            intellectual_property: "intellectual_property";
            receivable: "receivable";
            other_security: "other_security";
            other: "other";
            unknown: "unknown";
        }>>>;
        assetTypeCategoryLabel: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        txType: z.ZodEnum<{
            P: "P";
            S: "S";
            E: "E";
        }>;
        amountMin: z.ZodNullable<z.ZodNumber>;
        amountMax: z.ZodNullable<z.ZodNumber>;
        estValue: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        isOption: z.ZodBoolean;
        capGainsOver200: z.ZodBoolean;
        rawText: z.ZodString;
        filingStatus: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        subholding: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        location: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        supplementalText: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        rowKey: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        chamber: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
            house: "house";
            senate: "senate";
            executive: "executive";
        }>>>;
        memberName: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        filedDate: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        fullName: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        state: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        photoUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        firstSeenAt: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        sourceUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        refCompanyName: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        refSector: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        refMarketCap: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        refMarketCapBucket: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        refCountry: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        refExchangeShort: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        refAssetClass: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        confidence: z.ZodNumber;
        source: z.ZodEnum<{
            primary: "primary";
            seed_dataset: "seed_dataset";
            manual: "manual";
        }>;
        createdAt: z.ZodString;
        cursorSeq: z.ZodNumber;
    }, z.core.$strip>>;
    cursor: z.ZodNumber;
    count: z.ZodNumber;
    total: z.ZodNumber;
    limit: z.ZodNumber;
    offset: z.ZodOptional<z.ZodNumber>;
    filingsImportedToday: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
type TransactionsPage = z.infer<typeof TransactionsPageSchema>;
declare const TransactionsQuerySchema: z.ZodObject<{
    since: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
    from: z.ZodOptional<z.ZodString>;
    to: z.ZodOptional<z.ZodString>;
    ticker: z.ZodOptional<z.ZodString>;
    member: z.ZodOptional<z.ZodString>;
    chamber: z.ZodOptional<z.ZodEnum<{
        house: "house";
        senate: "senate";
        executive: "executive";
    }>>;
    type: z.ZodOptional<z.ZodEnum<{
        P: "P";
        S: "S";
        E: "E";
    }>>;
    limit: z.ZodOptional<z.ZodNumber>;
    order: z.ZodOptional<z.ZodEnum<{
        asc: "asc";
        desc: "desc";
    }>>;
}, z.core.$strip>;
type TransactionsQuery = z.infer<typeof TransactionsQuerySchema>;
declare const FundamentalRowSchema: z.ZodObject<{
    ticker: z.ZodString;
    date: z.ZodString;
    peRatio: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
    eps: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
    beta: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
    dividendYield: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
    week52High: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
    week52Low: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
    fcfYield: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
    debtToEquity: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
    epsGrowth: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
    source: z.ZodPreprocess<z.ZodOptional<z.ZodString>>;
    updatedAt: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
type FundamentalRow = z.infer<typeof FundamentalRowSchema>;
declare const AnalystRowSchema: z.ZodObject<{
    ticker: z.ZodString;
    date: z.ZodString;
    rating: z.ZodPreprocess<z.ZodOptional<z.ZodString>>;
    strongBuy: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
    buy: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
    hold: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
    sell: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
    strongSell: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
    targetMean: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
    targetHigh: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
    targetLow: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
    targetMedian: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
    analystCount: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
    source: z.ZodPreprocess<z.ZodOptional<z.ZodString>>;
    updatedAt: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
type AnalystRow = z.infer<typeof AnalystRowSchema>;
declare const InsiderRowSchema: z.ZodObject<{
    ticker: z.ZodString;
    date: z.ZodString;
    sentiment: z.ZodNumber;
    buyFilings: z.ZodNumber;
    sellFilings: z.ZodNumber;
    buyShares: z.ZodNumber;
    sellShares: z.ZodNumber;
    owners: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
type InsiderRow = z.infer<typeof InsiderRowSchema>;
/** Read-side shape returned by the ticker-scoped Congress.Trade insider endpoint. */
declare const InsiderReadRowSchema: z.ZodObject<{
    ticker: z.ZodString;
    date: z.ZodString;
    owners: z.ZodArray<z.ZodString>;
    sentiment: z.ZodNullable<z.ZodNumber>;
    buyFilings: z.ZodNullable<z.ZodNumber>;
    sellFilings: z.ZodNullable<z.ZodNumber>;
    buyShares: z.ZodNullable<z.ZodNumber>;
    sellShares: z.ZodNullable<z.ZodNumber>;
}, z.core.$strip>;
type InsiderReadRow = z.infer<typeof InsiderReadRowSchema>;
declare const ShortVolumeRowSchema: z.ZodObject<{
    ticker: z.ZodString;
    date: z.ZodString;
    ratio: z.ZodNumber;
    elevated: z.ZodBoolean;
}, z.core.$strip>;
type ShortVolumeRow = z.infer<typeof ShortVolumeRowSchema>;
/** Read-side shape returned by the ticker-scoped Congress.Trade short-volume endpoint. */
declare const ShortVolumeReadRowSchema: z.ZodObject<{
    ticker: z.ZodString;
    date: z.ZodString;
    elevated: z.ZodBoolean;
    ratio: z.ZodNullable<z.ZodNumber>;
}, z.core.$strip>;
type ShortVolumeReadRow = z.infer<typeof ShortVolumeReadRowSchema>;
declare const PriceSeriesSchema: z.ZodObject<{
    ticker: z.ZodString;
    closes: z.ZodArray<z.ZodObject<{
        date: z.ZodString;
        close: z.ZodNumber;
        volume: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
    }, z.core.$strip>>;
    currentPrice: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
    currentPriceDate: z.ZodPreprocess<z.ZodOptional<z.ZodString>>;
}, z.core.$strip>;
type PriceSeries = z.infer<typeof PriceSeriesSchema>;
declare const SharePayloadSchema: z.ZodObject<{
    refs: z.ZodOptional<z.ZodArray<z.ZodObject<{
        companyName: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        sector: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        industry: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        assetClass: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        isEtf: z.ZodOptional<z.ZodBoolean>;
        isAdr: z.ZodOptional<z.ZodBoolean>;
        country: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        stateHq: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        stateOfIncorp: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        exchange: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        exchangeShort: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        currency: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        marketCap: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        marketCapBucket: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
            mega: "mega";
            large: "large";
            mid: "mid";
            small: "small";
            micro: "micro";
            nano: "nano";
        }>>>;
        sharesOutstanding: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        ipoDate: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        cik: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        sicCode: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        sicDescription: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        source: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        enrichedAt: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
        currentPrice: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodNumber>>>;
        currentPriceDate: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
        ticker: z.ZodString;
    }, z.core.$strip>>>;
    spx: z.ZodOptional<z.ZodArray<z.ZodObject<{
        date: z.ZodString;
        close: z.ZodNumber;
        volume: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
    }, z.core.$strip>>>;
    prices: z.ZodOptional<z.ZodArray<z.ZodObject<{
        ticker: z.ZodString;
        closes: z.ZodArray<z.ZodObject<{
            date: z.ZodString;
            close: z.ZodNumber;
            volume: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
        }, z.core.$strip>>;
        currentPrice: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
        currentPriceDate: z.ZodPreprocess<z.ZodOptional<z.ZodString>>;
    }, z.core.$strip>>>;
    insider: z.ZodOptional<z.ZodArray<z.ZodObject<{
        ticker: z.ZodString;
        date: z.ZodString;
        sentiment: z.ZodNumber;
        buyFilings: z.ZodNumber;
        sellFilings: z.ZodNumber;
        buyShares: z.ZodNumber;
        sellShares: z.ZodNumber;
        owners: z.ZodArray<z.ZodString>;
    }, z.core.$strip>>>;
    shortVolume: z.ZodOptional<z.ZodArray<z.ZodObject<{
        ticker: z.ZodString;
        date: z.ZodString;
        ratio: z.ZodNumber;
        elevated: z.ZodBoolean;
    }, z.core.$strip>>>;
    fundamentals: z.ZodOptional<z.ZodArray<z.ZodObject<{
        ticker: z.ZodString;
        date: z.ZodString;
        peRatio: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
        eps: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
        beta: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
        dividendYield: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
        week52High: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
        week52Low: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
        fcfYield: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
        debtToEquity: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
        epsGrowth: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
        source: z.ZodPreprocess<z.ZodOptional<z.ZodString>>;
        updatedAt: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    analyst: z.ZodOptional<z.ZodArray<z.ZodObject<{
        ticker: z.ZodString;
        date: z.ZodString;
        rating: z.ZodPreprocess<z.ZodOptional<z.ZodString>>;
        strongBuy: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
        buy: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
        hold: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
        sell: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
        strongSell: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
        targetMean: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
        targetHigh: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
        targetLow: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
        targetMedian: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
        analystCount: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
        source: z.ZodPreprocess<z.ZodOptional<z.ZodString>>;
        updatedAt: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    origin: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
type SharePayload = z.infer<typeof SharePayloadSchema>;
declare const BundleResponseSchema: z.ZodObject<{
    ticker: z.ZodString;
    ref: z.ZodNullable<z.ZodObject<{
        ticker: z.ZodString;
        companyName: z.ZodNullable<z.ZodString>;
        sector: z.ZodNullable<z.ZodString>;
        industry: z.ZodNullable<z.ZodString>;
        assetClass: z.ZodNullable<z.ZodString>;
        isEtf: z.ZodBoolean;
        isAdr: z.ZodBoolean;
        country: z.ZodNullable<z.ZodString>;
        stateHq: z.ZodNullable<z.ZodString>;
        stateOfIncorp: z.ZodNullable<z.ZodString>;
        exchange: z.ZodNullable<z.ZodString>;
        exchangeShort: z.ZodNullable<z.ZodString>;
        currency: z.ZodNullable<z.ZodString>;
        marketCap: z.ZodNullable<z.ZodNumber>;
        marketCapBucket: z.ZodNullable<z.ZodEnum<{
            mega: "mega";
            large: "large";
            mid: "mid";
            small: "small";
            micro: "micro";
            nano: "nano";
        }>>;
        sharesOutstanding: z.ZodNullable<z.ZodNumber>;
        ipoDate: z.ZodNullable<z.ZodString>;
        cik: z.ZodNullable<z.ZodString>;
        sicCode: z.ZodNullable<z.ZodString>;
        sicDescription: z.ZodNullable<z.ZodString>;
        source: z.ZodNullable<z.ZodString>;
        enrichedAt: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        currentPrice: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        currentPriceDate: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, z.core.$strip>>;
    prices: z.ZodNullable<z.ZodObject<{
        ticker: z.ZodString;
        closes: z.ZodArray<z.ZodObject<{
            date: z.ZodString;
            close: z.ZodNumber;
            volume: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
        }, z.core.$strip>>;
        currentPrice: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
        currentPriceDate: z.ZodPreprocess<z.ZodOptional<z.ZodString>>;
    }, z.core.$strip>>;
    spx: z.ZodArray<z.ZodObject<{
        date: z.ZodString;
        close: z.ZodNumber;
        volume: z.ZodPreprocess<z.ZodOptional<z.ZodNumber>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
type BundleResponse = z.infer<typeof BundleResponseSchema>;
declare const CongressEventTypeSchema: z.ZodEnum<{
    "congress.trade": "congress.trade";
    "insider.update": "insider.update";
    "ref.upsert": "ref.upsert";
    "price.eod": "price.eod";
    "spx.eod": "spx.eod";
}>;
type CongressEventType = z.infer<typeof CongressEventTypeSchema>;
declare const CongressEventSchema: z.ZodObject<{
    type: z.ZodUnion<[z.ZodEnum<{
        "congress.trade": "congress.trade";
        "insider.update": "insider.update";
        "ref.upsert": "ref.upsert";
        "price.eod": "price.eod";
        "spx.eod": "spx.eod";
    }>, z.ZodString]>;
    id: z.ZodOptional<z.ZodString>;
    seq: z.ZodOptional<z.ZodNumber>;
    emittedAt: z.ZodOptional<z.ZodString>;
    data: z.ZodOptional<z.ZodUnknown>;
}, z.core.$strip>;
type CongressEvent = z.infer<typeof CongressEventSchema>;
declare const ConvictionTickerSchema: z.ZodObject<{
    ticker: z.ZodString;
    name: z.ZodPreprocess<z.ZodOptional<z.ZodString>>;
    convictionScore: z.ZodNullable<z.ZodNumber>;
    direction: z.ZodNullable<z.ZodEnum<{
        BUY: "BUY";
        SELL: "SELL";
    }>>;
    fallback: z.ZodOptional<z.ZodBoolean>;
    memberCount: z.ZodOptional<z.ZodNumber>;
    tradeCount: z.ZodOptional<z.ZodNumber>;
    directionalMembers: z.ZodOptional<z.ZodNumber>;
    directionalTrades: z.ZodOptional<z.ZodNumber>;
    netSentiment: z.ZodOptional<z.ZodNumber>;
    estNetFlowUsd: z.ZodOptional<z.ZodNumber>;
    parties: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
    components: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;
type ConvictionTicker = z.infer<typeof ConvictionTickerSchema>;
declare const TickerLeaderSchema: z.ZodObject<{
    ticker: z.ZodString;
    name: z.ZodPreprocess<z.ZodOptional<z.ZodString>>;
    tradeCount: z.ZodOptional<z.ZodNumber>;
    buyCount: z.ZodOptional<z.ZodNumber>;
    sellCount: z.ZodOptional<z.ZodNumber>;
    memberCount: z.ZodOptional<z.ZodNumber>;
    estVolumeUsd: z.ZodOptional<z.ZodNumber>;
    estNetFlowUsd: z.ZodOptional<z.ZodNumber>;
    netSentiment: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
type TickerLeader = z.infer<typeof TickerLeaderSchema>;
declare const ClusterBuySchema: z.ZodObject<{
    ticker: z.ZodPreprocess<z.ZodOptional<z.ZodString>>;
    name: z.ZodPreprocess<z.ZodOptional<z.ZodString>>;
    txType: z.ZodPreprocess<z.ZodOptional<z.ZodString>>;
    memberCount: z.ZodOptional<z.ZodNumber>;
    tradeCount: z.ZodOptional<z.ZodNumber>;
    estVolumeUsd: z.ZodOptional<z.ZodNumber>;
    firstSeen: z.ZodPreprocess<z.ZodOptional<z.ZodString>>;
    lastSeen: z.ZodPreprocess<z.ZodOptional<z.ZodString>>;
    parties: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
    topMembers: z.ZodOptional<z.ZodArray<z.ZodObject<{
        filerId: z.ZodPreprocess<z.ZodOptional<z.ZodString>>;
        fullName: z.ZodPreprocess<z.ZodOptional<z.ZodString>>;
        memberName: z.ZodPreprocess<z.ZodOptional<z.ZodString>>;
        name: z.ZodPreprocess<z.ZodOptional<z.ZodString>>;
        partyBucket: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
            D: "D";
            R: "R";
            O: "O";
        }>>>;
        photoUrl: z.ZodPreprocess<z.ZodOptional<z.ZodString>>;
        tradeCount: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>>;
}, z.core.$strip>;
type ClusterBuy = z.infer<typeof ClusterBuySchema>;
declare const MemberLeaderSchema: z.ZodObject<{
    filerId: z.ZodPreprocess<z.ZodOptional<z.ZodString>>;
    fullName: z.ZodPreprocess<z.ZodOptional<z.ZodString>>;
    memberName: z.ZodPreprocess<z.ZodOptional<z.ZodString>>;
    name: z.ZodPreprocess<z.ZodOptional<z.ZodString>>;
    party: z.ZodPreprocess<z.ZodOptional<z.ZodString>>;
    partyBucket: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
        D: "D";
        R: "R";
        O: "O";
    }>>>;
    chamber: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
        house: "house";
        senate: "senate";
        executive: "executive";
    }>>>;
    state: z.ZodPreprocess<z.ZodOptional<z.ZodString>>;
    photoUrl: z.ZodPreprocess<z.ZodOptional<z.ZodString>>;
    tradeCount: z.ZodOptional<z.ZodNumber>;
    buyCount: z.ZodOptional<z.ZodNumber>;
    sellCount: z.ZodOptional<z.ZodNumber>;
    uniqueTickers: z.ZodOptional<z.ZodNumber>;
    estVolumeUsd: z.ZodOptional<z.ZodNumber>;
    estNetFlowUsd: z.ZodOptional<z.ZodNumber>;
    netSentiment: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
type MemberLeader = z.infer<typeof MemberLeaderSchema>;
declare const MemberPerformanceSchema: z.ZodObject<{
    tradeCount: z.ZodOptional<z.ZodNumber>;
    scoredCount: z.ZodOptional<z.ZodNumber>;
    winRate: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    medianReturn: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    medianExcess: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    avgReturn: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    avgExcess: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
}, z.core.$strip>;
type MemberPerformance = z.infer<typeof MemberPerformanceSchema>;
declare const BacktestHorizonSchema: z.ZodObject<{
    days: z.ZodNumber;
    tradeCount: z.ZodNumber;
    n: z.ZodNumber;
    medianReturn: z.ZodNullable<z.ZodNumber>;
    avgReturn: z.ZodNullable<z.ZodNumber>;
    winRate: z.ZodNullable<z.ZodNumber>;
    medianExcess: z.ZodNullable<z.ZodNumber>;
    avgExcess: z.ZodNullable<z.ZodNumber>;
}, z.core.$strip>;
type BacktestHorizon = z.infer<typeof BacktestHorizonSchema>;
declare const TickerBacktestSchema: z.ZodObject<{
    ticker: z.ZodString;
    filerId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    txType: z.ZodString;
    totalBuyEvents: z.ZodNumber;
    pricedDays: z.ZodNumber;
    horizons: z.ZodArray<z.ZodObject<{
        days: z.ZodNumber;
        tradeCount: z.ZodNumber;
        n: z.ZodNumber;
        medianReturn: z.ZodNullable<z.ZodNumber>;
        avgReturn: z.ZodNullable<z.ZodNumber>;
        winRate: z.ZodNullable<z.ZodNumber>;
        medianExcess: z.ZodNullable<z.ZodNumber>;
        avgExcess: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>>;
}, z.core.$strip>;
type TickerBacktest = z.infer<typeof TickerBacktestSchema>;
declare const CommitteeConflictSchema: z.ZodObject<{
    id: z.ZodNullable<z.ZodString>;
    ticker: z.ZodNullable<z.ZodString>;
    sector: z.ZodString;
    txType: z.ZodNullable<z.ZodString>;
    txDate: z.ZodNullable<z.ZodString>;
    filerId: z.ZodNullable<z.ZodString>;
    memberName: z.ZodNullable<z.ZodString>;
    chamber: z.ZodNullable<z.ZodString>;
    partyBucket: z.ZodNullable<z.ZodEnum<{
        D: "D";
        R: "R";
        O: "O";
    }>>;
    viaCommittees: z.ZodArray<z.ZodString>;
    estAmountUsd: z.ZodNumber;
}, z.core.$strip>;
type CommitteeConflict = z.infer<typeof CommitteeConflictSchema>;
declare const SnapshotTableInfoSchema: z.ZodObject<{
    objectKey: z.ZodString;
    rowCount: z.ZodNumber;
}, z.core.$strip>;
type SnapshotTableInfo = z.infer<typeof SnapshotTableInfoSchema>;
declare const SnapshotManifestSchema: z.ZodObject<{
    generatedAt: z.ZodString;
    snapshotDate: z.ZodString;
    runId: z.ZodString;
    format: z.ZodLiteral<"ndjson">;
    tables: z.ZodRecord<z.ZodString, z.ZodObject<{
        objectKey: z.ZodString;
        rowCount: z.ZodNumber;
    }, z.core.$strip>>;
    schema: z.ZodRecord<z.ZodString, z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
type SnapshotManifest = z.infer<typeof SnapshotManifestSchema>;
declare const ClientMemberSchema: z.ZodObject<{
    id: z.ZodNullable<z.ZodString>;
    name: z.ZodNullable<z.ZodString>;
    chamber: z.ZodNullable<z.ZodEnum<{
        house: "house";
        senate: "senate";
        executive: "executive";
    }>>;
    party: z.ZodNullable<z.ZodString>;
    state: z.ZodNullable<z.ZodString>;
    photoUrl: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
type ClientMember = z.infer<typeof ClientMemberSchema>;
declare const ClientAssetSchema: z.ZodObject<{
    name: z.ZodString;
    ticker: z.ZodNullable<z.ZodString>;
    type: z.ZodNullable<z.ZodString>;
    sector: z.ZodNullable<z.ZodString>;
    marketCapBucket: z.ZodNullable<z.ZodString>;
    companyName: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    logoUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    typeName: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    typeCategory: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    typeCategoryLabel: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$strip>;
type ClientAsset = z.infer<typeof ClientAssetSchema>;
declare const ClientTransactionSchema: z.ZodObject<{
    date: z.ZodNullable<z.ZodString>;
    type: z.ZodEnum<{
        P: "P";
        S: "S";
        E: "E";
    }>;
    owner: z.ZodNullable<z.ZodString>;
    amountMin: z.ZodNullable<z.ZodNumber>;
    amountMax: z.ZodNullable<z.ZodNumber>;
    estValue: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    isOption: z.ZodBoolean;
}, z.core.$strip>;
type ClientTransaction = z.infer<typeof ClientTransactionSchema>;
declare const ClientFilingSchema: z.ZodObject<{
    filedDate: z.ZodNullable<z.ZodString>;
    firstSeenAt: z.ZodNullable<z.ZodString>;
    sourceUrl: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
type ClientFiling = z.infer<typeof ClientFilingSchema>;
declare const ClientTradeSchema: z.ZodObject<{
    id: z.ZodString;
    cursor: z.ZodNumber;
    docId: z.ZodString;
    member: z.ZodObject<{
        id: z.ZodNullable<z.ZodString>;
        name: z.ZodNullable<z.ZodString>;
        chamber: z.ZodNullable<z.ZodEnum<{
            house: "house";
            senate: "senate";
            executive: "executive";
        }>>;
        party: z.ZodNullable<z.ZodString>;
        state: z.ZodNullable<z.ZodString>;
        photoUrl: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>;
    asset: z.ZodObject<{
        name: z.ZodString;
        ticker: z.ZodNullable<z.ZodString>;
        type: z.ZodNullable<z.ZodString>;
        sector: z.ZodNullable<z.ZodString>;
        marketCapBucket: z.ZodNullable<z.ZodString>;
        companyName: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        logoUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        typeName: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        typeCategory: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        typeCategoryLabel: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, z.core.$strip>;
    transaction: z.ZodObject<{
        date: z.ZodNullable<z.ZodString>;
        type: z.ZodEnum<{
            P: "P";
            S: "S";
            E: "E";
        }>;
        owner: z.ZodNullable<z.ZodString>;
        amountMin: z.ZodNullable<z.ZodNumber>;
        amountMax: z.ZodNullable<z.ZodNumber>;
        estValue: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        isOption: z.ZodBoolean;
    }, z.core.$strip>;
    filing: z.ZodObject<{
        filedDate: z.ZodNullable<z.ZodString>;
        firstSeenAt: z.ZodNullable<z.ZodString>;
        sourceUrl: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>;
    confidence: z.ZodNumber;
    source: z.ZodEnum<{
        primary: "primary";
        seed_dataset: "seed_dataset";
        manual: "manual";
    }>;
}, z.core.$strip>;
type ClientTrade = z.infer<typeof ClientTradeSchema>;
declare const AmountBracketSchema: z.ZodObject<{
    min: z.ZodNumber;
    max: z.ZodNullable<z.ZodNumber>;
}, z.core.$strip>;
declare const SubscriptionSchema: z.ZodObject<{
    id: z.ZodString;
    secret: z.ZodString;
    streamUrl: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
declare const SseMessageSchema: z.ZodObject<{
    event: z.ZodOptional<z.ZodString>;
    id: z.ZodOptional<z.ZodString>;
    data: z.ZodString;
}, z.core.$strip>;
/**
 * Parses an unknown value as an array of the given schema.
 * Returns the parsed array on success, or null on failure.
 * Useful for validating API responses at runtime.
 */
declare function parseArray<T>(schema: z.ZodType<T>, data: unknown): T[] | null;
/**
 * Parses an unknown value against a schema.
 * Returns the parsed value on success, or null on failure.
 */
declare function parseSafe<T>(schema: z.ZodType<T>, data: unknown): T | null;

/** Continuous renames/rebrands: same listed entity, price history continues under the new ticker. */
declare const TICKER_RENAMES: Readonly<Record<string, string>>;
/**
 * Delisting acquisitions: source ticker ceased trading in a takeover; its price series is
 * discontinuous. The `to` target is the curated successor used for identity/display resolution —
 * for a multi-step history it is the current successor, which may be several corporate actions
 * removed from the immediate 2018-style acquirer (see TWX below). These targets are a stable
 * contract (existing consumers/tests depend on them); do not repoint them without a major bump.
 */
declare const TICKER_ACQUISITIONS: Readonly<Record<string, string>>;
/**
 * Union of every curated ticker alias (renames + acquisitions), for IDENTITY/display resolution
 * where only the current ticker matters. Kept as a flat map for backward compatibility.
 *
 * NOTE: this map is PIT-UNSAFE — it folds acquisition sources (ATVI→MSFT, …) into the acquirer,
 * so point-in-time logic that resolves through it will attribute a delisted position to the
 * acquirer's ongoing price series. Use `classifyTickerAlias()` / `resolveContinuousTicker()`
 * when the corporate-action class matters. Its key enumeration order (renames then acquisitions)
 * is NOT part of the contract — treat it as an unordered lookup map.
 */
declare const TICKER_ALIASES: Readonly<Record<string, string>>;
declare const MKT_CAP_THRESHOLDS: Readonly<{
    readonly MEGA: 200000000000;
    readonly LARGE: 10000000000;
    readonly MID: 2000000000;
    readonly SMALL: 300000000;
    readonly MICRO: 50000000;
}>;
declare const API_PATHS: Readonly<{
    readonly HEALTH: "/api/health";
    readonly TRANSACTIONS: "/api/transactions";
    readonly STREAM: "/api/stream";
    readonly MARKET_BUNDLE: "/api/market/bundle";
    readonly MARKET_REF: "/api/market/ref";
    readonly MARKET_REFS: "/api/market/refs";
    readonly MARKET_PRICES: "/api/market/prices";
    readonly MARKET_SPX: "/api/market/spx";
    readonly MARKET_FUNDAMENTALS: "/api/market/fundamentals";
    readonly MARKET_ANALYST: "/api/market/analyst";
    readonly MARKET_INSIDER: "/api/market/insider";
    readonly MARKET_SHORT_VOLUME: "/api/market/short-volume";
    readonly ANALYTICS_TICKER_LEADERBOARD: "/api/analytics/ticker-leaderboard";
    readonly ANALYTICS_CONVICTION: "/api/analytics/conviction";
    readonly ANALYTICS_MEMBER_LEADERBOARD: "/api/analytics/member-leaderboard";
    readonly ANALYTICS_CLUSTER_BUYS: "/api/analytics/cluster-buys";
    readonly ANALYTICS_MEMBER_PERFORMANCE: "/api/analytics/member";
    readonly ANALYTICS_TICKER_BACKTEST: "/api/analytics/ticker";
    readonly ANALYTICS_CONFLICTS: "/api/analytics/conflicts";
    readonly ADMIN_SECURITIES_IMPORT: "/api/admin/securities/import";
    readonly EXPORT_BULK_SNAPSHOT: "/api/export/bulk-snapshot";
    readonly SUBSCRIPTIONS: "/api/subscriptions";
}>;
declare const WINDOW_PRESETS: readonly ["1d", "7d", "30d", "90d", "180d", "365d", "1825d", "all"];
type Window = (typeof WINDOW_PRESETS)[number];
declare const LAG_BUCKETS: readonly [Readonly<{
    label: "0-7d";
    max: 7;
}>, Readonly<{
    label: "8-14d";
    max: 14;
}>, Readonly<{
    label: "15-30d";
    max: 30;
}>, Readonly<{
    label: "31-45d";
    max: 45;
}>, Readonly<{
    label: "46-60d";
    max: 60;
}>, Readonly<{
    label: "60d+";
    max: null;
}>];
declare const DEFAULT_CONGRESS_TRADE_BASE_URL = "https://congress.trade";
declare const DEFAULT_TRANSACTIONS_LIMIT = 100;
declare const MAX_REFS_BATCH = 500;
declare const APP_B_ORIGIN_TAG: "app-b";
declare const CONGRESS_EVENT_TYPES: readonly ["congress.trade", "insider.update", "ref.upsert", "price.eod", "spx.eod"];

/**
 * Class of a curated ticker alias:
 * - `rename` — a continuous rename/rebrand (same listed entity, price series continues).
 * - `acquisition` — a delisting takeover (source ticker's price series ends at the deal).
 */
type TickerAliasClass = "rename" | "acquisition";
/** Resolution of a ticker alias source to its target, tagged with the corporate-action class. */
interface TickerAliasResolution {
    /** The normalized source ticker (the alias key). */
    from: string;
    /** The current/target ticker the alias maps to. */
    to: string;
    /** Whether the mapping is a continuous rename or a discontinuous acquisition. */
    class: TickerAliasClass;
}

declare const WELL_FORMED_TICKER: RegExp;
/** Clean a raw symbol: trim, uppercase, drop surrounding quotes/brackets. */
declare function clean(raw: string | null | undefined): string;
/** Normalize a raw ticker string: uppercase, strip whitespace, validate format. */
declare function normalizeTicker(raw: string | null | undefined): string | null;
/** True when the raw value is a "no ticker" placeholder (dash, N/A, blank). */
declare function isPlaceholderTicker(raw: string | null | undefined): boolean;
/** Strip a preferred/depositary `$`-series suffix: "T$A" → "T", "RF$E" → "RF". */
declare function stripPreferredSeries(sym: string): string;
/** Normalize common preferred/depositary-share ticker spellings. */
declare function normalizePreferredTickerVariant(raw: string | null | undefined): string | null;
/** Resolve preferred/depositary-share descriptions that include no ticker. */
declare function resolvePreferredTickerFromAssetName(assetName: string | null | undefined, resolveIssuerTicker: (issuerName: string) => string | null): string | null;
/** Distinct share-class punctuation variants. */
declare function punctuationVariants(sym: string): string[];
/** True when `sym` is a syntactically valid ticker we'll accept without a master hit. */
declare function isWellFormedTicker(sym: string): boolean;
/** Fallback ticker resolver logic. */
declare function resolveTickerDeterministic(raw: string | null | undefined, isKnown: (sym: string) => string | null): string | null;
/**
 * Resolve any curated ticker alias to its current ticker — renames AND acquisitions alike.
 *
 * This is IDENTITY/display resolution: it answers "what does this old ticker map to now?" and
 * is the right call for de-duplicating a securities master or rendering a current symbol. When
 * the corporate-action class matters — e.g. point-in-time return attribution, where an
 * acquired-and-delisted position must NOT inherit the acquirer's later price history — use
 * `classifyTickerAlias()` or the renames-only `resolveContinuousTicker()` instead.
 */
declare function resolveTickerAlias(ticker: string, aliases?: Readonly<Record<string, string>>): string;
/**
 * Classify a ticker alias as a continuous `rename` or a discontinuous `acquisition`, returning
 * the normalized source, its target, and the class — or `null` when the ticker is not a known
 * alias source (i.e. it is already current, or unknown).
 *
 * The class is what point-in-time (PIT) logic needs: `rename` targets share a continuous price
 * series (folding old→new is correct), whereas `acquisition` sources were delisted at the deal
 * and their series ends there (the position should be treated as closed, not rolled into the
 * acquirer's ongoing series). `renames` is checked before `acquisitions`; the two curated maps
 * are disjoint on their SOURCE keys by construction, so ordering only matters if a caller passes
 * overlapping maps.
 *
 * Resolution is SINGLE-HOP and non-transitive: a source maps directly to its curated current
 * target with no chaining. The curated maps are intentionally non-chained (no target is also a
 * source), so a compound history (rename X→Y, then Y acquired→Z) is not representable here and
 * would need a richer model — see docs/rollouts/2026-07-05-ticker-alias-rename-vs-acquisition.md.
 */
declare function classifyTickerAlias(ticker: string, opts?: {
    renames?: Readonly<Record<string, string>>;
    acquisitions?: Readonly<Record<string, string>>;
}): TickerAliasResolution | null;
/**
 * PIT-safe ticker resolution: fold ONLY continuous renames (e.g. FB→META) to the current
 * ticker and leave acquisition sources (ATVI, RHT, …) untouched, so downstream point-in-time
 * logic keeps a delisted series distinct from its acquirer's. Contrast with `resolveTickerAlias`,
 * which folds every alias for pure identity/display resolution.
 */
declare function resolveContinuousTicker(ticker: string, renames?: Readonly<Record<string, string>>): string;
/** Compute the market-cap bucket from a dollar value. */
declare function marketCapBucket(n: number | null | undefined): MktCapBucket | null;
/** Compute the midpoint of a STOCK Act dollar-amount bracket. */
declare function bracketMidpoint(min: number | null, max: number | null): number;
/** Check if a string is a valid YYYY-MM-DD date. */
declare function isIsoDate(s: string): boolean;
/** Days between two YYYY-MM-DD strings. */
declare function daysBetween(a: string, b: string): number;
/** Merge two partial refs, preferring the second (later/more authoritative) for non-null fields. */
declare function mergeRefs<T extends Record<string, unknown>>(a: Partial<T> | null | undefined, b: Partial<T> | Record<string, unknown> | null | undefined): Partial<T>;

declare const UsageTelemetryMetricTypeSchema: z.ZodEnum<{
    limit: "limit";
    usage: "usage";
    cost: "cost";
    quota: "quota";
    tier: "tier";
    health: "health";
    balance: "balance";
    quota_sync: "quota_sync";
    credit_balance: "credit_balance";
    subscription: "subscription";
}>;
declare const UsageTelemetryUnitSchema: z.ZodEnum<{
    request: "request";
    call: "call";
    token: "token";
    credit: "credit";
    usd: "usd";
    page: "page";
    job: "job";
    document: "document";
    row: "row";
    byte: "byte";
}>;
declare const UsageTelemetryBillingModeSchema: z.ZodEnum<{
    manual: "manual";
    actual: "actual";
    estimated: "estimated";
}>;
declare const UsageTelemetryConfidenceSchema: z.ZodEnum<{
    manual: "manual";
    actual: "actual";
    estimated: "estimated";
}>;
declare const UsageTelemetryLimitWindowSchema: z.ZodEnum<{
    minute: "minute";
    day: "day";
    month: "month";
    run: "run";
}>;
declare const UsageTelemetryMetadataSchema: z.ZodPipe<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodNull]>>, z.ZodTransform<Record<string, string | number | boolean | null>, Record<string, string | number | boolean | null>>>;
declare const UsageTelemetryEventSchema: z.ZodObject<{
    sourceApp: z.ZodString;
    environment: z.ZodOptional<z.ZodString>;
    provider: z.ZodString;
    service: z.ZodOptional<z.ZodString>;
    project: z.ZodOptional<z.ZodString>;
    label: z.ZodOptional<z.ZodString>;
    keyRef: z.ZodOptional<z.ZodString>;
    billingMode: z.ZodDefault<z.ZodEnum<{
        manual: "manual";
        actual: "actual";
        estimated: "estimated";
    }>>;
    metricType: z.ZodDefault<z.ZodEnum<{
        limit: "limit";
        usage: "usage";
        cost: "cost";
        quota: "quota";
        tier: "tier";
        health: "health";
        balance: "balance";
        quota_sync: "quota_sync";
        credit_balance: "credit_balance";
        subscription: "subscription";
    }>>;
    quantity: z.ZodOptional<z.ZodNumber>;
    unit: z.ZodOptional<z.ZodEnum<{
        request: "request";
        call: "call";
        token: "token";
        credit: "credit";
        usd: "usd";
        page: "page";
        job: "job";
        document: "document";
        row: "row";
        byte: "byte";
    }>>;
    costUsd: z.ZodOptional<z.ZodNumber>;
    requests: z.ZodOptional<z.ZodNumber>;
    credits: z.ZodOptional<z.ZodNumber>;
    limit: z.ZodOptional<z.ZodNumber>;
    limitWindow: z.ZodOptional<z.ZodEnum<{
        minute: "minute";
        day: "day";
        month: "month";
        run: "run";
    }>>;
    tier: z.ZodOptional<z.ZodString>;
    confidence: z.ZodDefault<z.ZodEnum<{
        manual: "manual";
        actual: "actual";
        estimated: "estimated";
    }>>;
    windowStart: z.ZodOptional<z.ZodString>;
    windowEnd: z.ZodOptional<z.ZodString>;
    occurredAt: z.ZodOptional<z.ZodString>;
    providerRequestId: z.ZodOptional<z.ZodString>;
    metadata: z.ZodOptional<z.ZodPipe<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodNull]>>, z.ZodTransform<Record<string, string | number | boolean | null>, Record<string, string | number | boolean | null>>>>;
    idempotencyKey: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
declare const UsageTelemetryBatchSchema: z.ZodObject<{
    events: z.ZodArray<z.ZodObject<{
        sourceApp: z.ZodString;
        environment: z.ZodOptional<z.ZodString>;
        provider: z.ZodString;
        service: z.ZodOptional<z.ZodString>;
        project: z.ZodOptional<z.ZodString>;
        label: z.ZodOptional<z.ZodString>;
        keyRef: z.ZodOptional<z.ZodString>;
        billingMode: z.ZodDefault<z.ZodEnum<{
            manual: "manual";
            actual: "actual";
            estimated: "estimated";
        }>>;
        metricType: z.ZodDefault<z.ZodEnum<{
            limit: "limit";
            usage: "usage";
            cost: "cost";
            quota: "quota";
            tier: "tier";
            health: "health";
            balance: "balance";
            quota_sync: "quota_sync";
            credit_balance: "credit_balance";
            subscription: "subscription";
        }>>;
        quantity: z.ZodOptional<z.ZodNumber>;
        unit: z.ZodOptional<z.ZodEnum<{
            request: "request";
            call: "call";
            token: "token";
            credit: "credit";
            usd: "usd";
            page: "page";
            job: "job";
            document: "document";
            row: "row";
            byte: "byte";
        }>>;
        costUsd: z.ZodOptional<z.ZodNumber>;
        requests: z.ZodOptional<z.ZodNumber>;
        credits: z.ZodOptional<z.ZodNumber>;
        limit: z.ZodOptional<z.ZodNumber>;
        limitWindow: z.ZodOptional<z.ZodEnum<{
            minute: "minute";
            day: "day";
            month: "month";
            run: "run";
        }>>;
        tier: z.ZodOptional<z.ZodString>;
        confidence: z.ZodDefault<z.ZodEnum<{
            manual: "manual";
            actual: "actual";
            estimated: "estimated";
        }>>;
        windowStart: z.ZodOptional<z.ZodString>;
        windowEnd: z.ZodOptional<z.ZodString>;
        occurredAt: z.ZodOptional<z.ZodString>;
        providerRequestId: z.ZodOptional<z.ZodString>;
        metadata: z.ZodOptional<z.ZodPipe<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodNull]>>, z.ZodTransform<Record<string, string | number | boolean | null>, Record<string, string | number | boolean | null>>>>;
        idempotencyKey: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
declare const UsageTelemetryIngestResponseSchema: z.ZodObject<{
    ok: z.ZodBoolean;
    accepted: z.ZodNumber;
    ignoredPruned: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
type UsageTelemetryMetricType = z.infer<typeof UsageTelemetryMetricTypeSchema>;
type UsageTelemetryUnit = z.infer<typeof UsageTelemetryUnitSchema>;
type UsageTelemetryBillingMode = z.infer<typeof UsageTelemetryBillingModeSchema>;
type UsageTelemetryConfidence = z.infer<typeof UsageTelemetryConfidenceSchema>;
type UsageTelemetryLimitWindow = z.infer<typeof UsageTelemetryLimitWindowSchema>;
type UsageTelemetryEventInput = z.input<typeof UsageTelemetryEventSchema>;
type UsageTelemetryEvent = z.infer<typeof UsageTelemetryEventSchema>;
type UsageTelemetryBatchInput = z.input<typeof UsageTelemetryBatchSchema>;
type UsageTelemetryBatch = z.infer<typeof UsageTelemetryBatchSchema>;
type UsageTelemetryIngestResponse = z.infer<typeof UsageTelemetryIngestResponseSchema>;
declare const API_USAGE_MONITOR_INGEST_PATH = "/api/ingest/usage";
declare function usageMonitorIngestUrl(baseUrl: string): string;
/**
 * Computes the same deterministic idempotency key the API Usage Monitor server
 * derives server-side as a fallback (see `deriveIdempotencyKey` in that repo's
 * `src/lib/usage-telemetry.ts`). Computing and attaching it here ensures
 * retries of the same event collapse to the same key instead of each retry
 * getting its own random fallback key on the server.
 *
 * CONTRACT — this MUST stay byte-for-byte identical to the server algorithm:
 *   basis = encodeField(sourceApp) + encodeField(provider) + encodeField(metricType)
 *         + encodeField(keyRef ?? "") + encodeField(occurredAt)
 *   key   = sha256Hex(basis)
 * where encodeField(v) = `${utf8ByteLength(v)}:${v}` (see encodeIdempotencyField).
 *
 * Both sides apply their own defaulting (e.g. metricType -> "usage") BEFORE
 * computing the basis string, so `event` here is expected to already be the
 * fully-defaulted event (see `send()` below, which derives the key from
 * `UsageTelemetryBatchSchema.parse(...)` output, after Zod's `.default()`
 * values have been applied). If either side ever changes the field order,
 * the encoding scheme, the hash algorithm, or *when* defaults are applied
 * relative to hashing, idempotency will silently break — update both repos
 * together and bump a version marker if the format ever changes.
 */
declare function deriveUsageTelemetryIdempotencyKey(event: {
    sourceApp: string;
    provider: string;
    metricType: string;
    keyRef?: string;
    occurredAt?: string;
}): Promise<string | undefined>;
interface UsageTelemetryClientOptions {
    baseUrl: string;
    token: string;
    fetchImpl?: typeof fetch;
    /** Reject events without a caller-supplied identity instead of relying on the five-field fallback. */
    requireExplicitIdempotencyKey?: boolean;
}
declare function createUsageTelemetryClient(options: UsageTelemetryClientOptions): {
    send(events: UsageTelemetryEventInput[]): Promise<UsageTelemetryIngestResponse>;
};

/**
 * Shared identity/classification context for a single outbound provider call.
 * `sourceApp` is required; every other field is optional and simply omitted
 * from the builder outputs when absent.
 *
 * Static classifier fields reject blank strings (fail fast — they are
 * deploy-time constants). The runtime-dynamic `user`/`sessionId` fields
 * instead collapse blank/whitespace-only values to absent.
 */
declare const CallClassifierContextSchema: z.ZodObject<{
    sourceApp: z.ZodString;
    environment: z.ZodOptional<z.ZodString>;
    service: z.ZodOptional<z.ZodString>;
    feature: z.ZodOptional<z.ZodString>;
    keyRef: z.ZodOptional<z.ZodString>;
    gitSha: z.ZodOptional<z.ZodString>;
    user: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<string | undefined, string>>>;
    sessionId: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<string | undefined, string>>>;
}, z.core.$strip>;
type CallClassifierContext = z.infer<typeof CallClassifierContextSchema>;
/**
 * The flat `trace` object merged into an OpenRouter request body. Per
 * OpenRouter's Broadcast docs, `trace` itself carries arbitrary metadata
 * keys — there is no `metadata` sub-object.
 */
interface CallClassifierTrace {
    sourceApp: string;
    environment?: string;
    service?: string;
    feature?: string;
    keyRef?: string;
    gitSha?: string;
}
/**
 * Fields to merge into an OpenRouter completions request body. Spread this
 * into the request body — do NOT rename `trace`, nest its fields under a
 * `metadata` sub-object, or hoist them to the top level; OpenRouter treats
 * `trace` itself as the arbitrary-metadata object.
 */
interface OpenRouterRequestEnrichment {
    user?: string;
    session_id?: string;
    trace: CallClassifierTrace;
}
/**
 * Flat string map of classifier fields, safe to merge into a pushed
 * `UsageTelemetryEvent`'s `metadata` field (see `UsageTelemetryMetadataSchema`
 * in `usageTelemetry.ts`, which accepts `Record<string, string | number |
 * boolean | null>`).
 */
type CallClassifierTelemetryMetadata = Record<string, string>;
/** Combined output of applying both classifier builders to the same context. */
interface CallClassifierOutputs {
    openrouterRequestEnrichment: OpenRouterRequestEnrichment;
    telemetryMetadata: CallClassifierTelemetryMetadata;
}
/**
 * Builds the fields to merge into an OpenRouter completions request body:
 * top-level `user`/`session_id` plus a flat `trace: { sourceApp, ... }`
 * object (no `metadata` nesting anywhere).
 *
 * Throws if a STATIC classifier field fails validation (e.g. missing/blank
 * `sourceApp`) — those are deploy-time constants and should fail fast. The
 * runtime-dynamic `user`/`sessionId` are OMITTED (never thrown on) when
 * undefined, empty, or whitespace-only, so a blank per-call id can never
 * break a paid LLM request.
 *
 * Caller contract: for absent optional STATIC fields pass `undefined`, never
 * `""` (a blank static field throws by design). Telemetry producers pushing
 * the provider's generation id should likewise send
 * `response.id || undefined` for `providerRequestId` — never an empty string.
 */
declare function openrouterRequestEnrichment(ctx: CallClassifierContext): OpenRouterRequestEnrichment;
/**
 * Builds the classifier fields to attach to a pushed usage-telemetry event's
 * `metadata` map.
 *
 * Throws if a STATIC classifier field fails validation (e.g. missing/blank
 * `sourceApp`); the runtime-dynamic `user`/`sessionId` are omitted when
 * undefined, empty, or whitespace-only (see `openrouterRequestEnrichment`
 * for the full caller contract).
 */
declare function telemetryEventClassifier(ctx: CallClassifierContext): CallClassifierTelemetryMetadata;
/**
 * Convenience wrapper returning both classifier shapes for the same context
 * in one call. Equivalent to calling `openrouterRequestEnrichment(ctx)` and
 * `telemetryEventClassifier(ctx)` separately.
 */
declare function buildCallClassifier(ctx: CallClassifierContext): CallClassifierOutputs;

/**
 * Backfill producer-omitted nullable metadata on a raw security-ref payload so
 * it satisfies {@link SecurityRefSchema}.
 *
 * `SecurityRefSchema.sharesOutstanding` is `.nullable()` but NOT `.optional()`,
 * so the key must be *present* — `null` is accepted, absent is not. The live
 * Congress.Trade REST producer does not emit `sharesOutstanding` at all, which
 * would otherwise make every strict ref/bundle read throw.
 *
 * `CongressTradeClient` applies this automatically on every read path. It is
 * exported because consumers that bypass the client and call
 * `SecurityRefSchema.parse(...)` directly need the same normalization — without
 * it they hit `Invalid market ref response` on well-formed producer payloads.
 *
 * Non-object input (null, arrays, primitives) is returned unchanged so callers
 * can pass raw JSON through before validating it.
 */
declare function normalizeSecurityRef(value: unknown): unknown;
declare class CongressTradeHttpError extends Error {
    readonly method: string;
    readonly path: string;
    readonly status: number;
    constructor(method: string, path: string, status: number);
}
interface CongressTradeClientConfig {
    baseUrl?: string;
    token?: string;
    fetch?: typeof fetch;
}
interface Subscription {
    id: string;
    secret: string;
    streamUrl?: string;
}
declare class CongressTradeClient {
    private baseUrl;
    private token?;
    private fetchApi;
    constructor(config?: CongressTradeClientConfig);
    private headers;
    private getJson;
    /**
     * Create an SSE subscription on behalf of an already-authenticated end user.
     * Current Congress.Trade derives ownership from the user session and ignores
     * `clientId`; the field remains on the wire for compatibility with older servers.
     */
    createSubscription(clientId: string, desiredSecret?: string): Promise<Subscription>;
    /**
     * Build an SSE URL. Pass the per-subscription secret for EventSource-style
     * clients; callers that omit it must send the same secret as a Bearer header.
     */
    streamUrl(subscriptionId: string, secret?: string): string;
    getBundle(ticker: string, opts?: {
        from?: string;
        to?: string;
    }): Promise<BundleResponse>;
    getRef(ticker: string): Promise<SecurityRef | null>;
    getRefs(tickers: string[]): Promise<SecurityRef[]>;
    getPrices(ticker: string, opts?: {
        from?: string;
        to?: string;
    }): Promise<PriceSeries>;
    getSpx(opts?: {
        from?: string;
        to?: string;
    }): Promise<PriceClose[]>;
    getFundamentals(ticker: string, opts?: {
        from?: string;
        to?: string;
    }): Promise<FundamentalRow[]>;
    getAnalyst(ticker: string, opts?: {
        from?: string;
        to?: string;
    }): Promise<AnalystRow[]>;
    getInsider(ticker: string, opts?: {
        from?: string;
        to?: string;
    }): Promise<InsiderReadRow[]>;
    getShortVolume(ticker: string, opts?: {
        from?: string;
        to?: string;
    }): Promise<ShortVolumeReadRow[]>;
    getTransactions(query?: TransactionsQuery): Promise<TransactionsPage>;
    getTickerLeaderboard(opts?: {
        window?: string;
        limit?: number;
    }): Promise<TickerLeader[]>;
    getClusterBuys(opts?: {
        window?: string;
        limit?: number;
    }): Promise<ClusterBuy[]>;
    getMemberLeaderboard(opts?: {
        window?: string;
        limit?: number;
    }): Promise<MemberLeader[]>;
    getMemberPerformance(filerId: string): Promise<MemberPerformance | null>;
    getConviction(opts?: {
        window?: string;
        limit?: number;
    }): Promise<ConvictionTicker[]>;
    getTickerBacktest(ticker: string, opts?: {
        window?: string;
        horizons?: string;
        filerId?: string;
    }): Promise<TickerBacktest | null>;
    getConflicts(opts?: {
        window?: string;
        limit?: number;
        chamber?: string;
        party?: string;
    }): Promise<CommitteeConflict[]>;
}
interface SseMessage {
    event?: string;
    id?: string;
    data: string;
}
interface SseParserOptions {
    /** Maximum characters allowed in one SSE field line before the parser resets and throws. */
    maxLineLength?: number;
    /** Maximum joined data characters allowed in one event before the parser resets and throws. */
    maxEventDataLength?: number;
}
/** Incremental text/event-stream parser. Feed decoded chunks; get back complete events. */
declare class SseParser {
    private buf;
    private cur;
    private lastEventId;
    private atStart;
    private swallowLeadingLf;
    private eventDataLength;
    private readonly maxLineLength;
    private readonly maxEventDataLength;
    constructor(options?: SseParserOptions);
    private resetAfterLimit;
    push(chunk: string): SseMessage[];
}

/**
 * Creates a standardized CongressEvent object.
 * Automatically assigns `emittedAt` to the current ISO time if not provided.
 */
declare function createCongressEvent<T = unknown>(type: CongressEventType | string, data?: T, options?: Omit<CongressEvent, "type" | "data">): CongressEvent;

/** A single STOCK Act amount bracket in whole USD. `max === null` => open-ended top tier. */
interface AmountBracket {
    min: number;
    max: number | null;
}
/**
 * The canonical STOCK Act bracket set (ascending). The final tier ($50,000,001+)
 * is open-ended and represented with max === null.
 */
declare const STOCK_ACT_BRACKETS: readonly AmountBracket[];
/**
 * Return the canonical bracket exactly matching the provided bounds, or null if
 * the pair is not a valid STOCK Act bracket. `max` may be null (open top tier).
 */
declare function matchBracket(min: number, max: number | null): AmountBracket | null;
/** True iff [min,max] is one of the canonical STOCK Act brackets. */
declare function isValidBracket(min: number, max: number | null): boolean;
/**
 * Snap an arbitrary [min,max] guess to the closest containing canonical bracket.
 * Useful when an extractor produces near-but-not-exact bounds. Returns null when
 * nothing plausibly contains the range.
 */
declare function nearestBracket(min: number, max: number | null): AmountBracket | null;

declare const OperationGuardRateLimitedSchema: z.ZodObject<{
    code: z.ZodLiteral<"rate_limited">;
    operation: z.ZodString;
    retryAfterSeconds: z.ZodNumber;
}, z.core.$strip>;
type OperationGuardRateLimited = z.infer<typeof OperationGuardRateLimitedSchema>;
declare const OperationGuardInFlightSchema: z.ZodObject<{
    code: z.ZodLiteral<"operation_in_flight">;
    operation: z.ZodString;
    activeOperation: z.ZodString;
}, z.core.$strip>;
type OperationGuardInFlight = z.infer<typeof OperationGuardInFlightSchema>;
declare const OperationGuardRejectionSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    code: z.ZodLiteral<"rate_limited">;
    operation: z.ZodString;
    retryAfterSeconds: z.ZodNumber;
}, z.core.$strip>, z.ZodObject<{
    code: z.ZodLiteral<"operation_in_flight">;
    operation: z.ZodString;
    activeOperation: z.ZodString;
}, z.core.$strip>], "code">;
type OperationGuardRejection = z.infer<typeof OperationGuardRejectionSchema>;
declare function buildRateLimitedRejection(operation: string, retryAfterSeconds: number): OperationGuardRateLimited;
declare function buildOperationInFlightRejection(operation: string, activeOperation: string): OperationGuardInFlight;
declare function getOperationGuardHttpStatus(rejection: OperationGuardRejection): number;

/**
 * src/webhookAuth.ts
 */
declare function signCongressWebhook(body: string, secret: string): Promise<string>;
/**
 * Verify a congress webhook signature.
 * Tolerates the optional "sha256=" prefix historically sent by Congress.Trade.
 */
declare function verifyCongressWebhookSignature(body: string, signatureHeader: string, secret: string): Promise<boolean>;

export { API_PATHS, API_USAGE_MONITOR_INGEST_PATH, APP_B_ORIGIN_TAG as APP_B_ORIGIN, APP_B_ORIGIN_TAG, type AmountBracket, AmountBracketSchema, type AnalystRow, AnalystRowSchema, type AssetTypeCategory, AssetTypeCategorySchema, type BacktestHorizon, BacktestHorizonSchema, type BundleResponse, BundleResponseSchema, CONGRESS_EVENT_TYPES, type CallClassifierContext, CallClassifierContextSchema, type CallClassifierOutputs, type CallClassifierTelemetryMetadata, type CallClassifierTrace, type Chamber, ChamberSchema, type ClientAsset, ClientAssetSchema, type ClientFiling, ClientFilingSchema, type ClientMember, ClientMemberSchema, type ClientTrade, ClientTradeSchema, type ClientTransaction, ClientTransactionSchema, type ClusterBuy, ClusterBuySchema, type CommitteeConflict, CommitteeConflictSchema, type CongressEvent, CongressEventSchema, type CongressEventType, CongressEventTypeSchema, CongressTradeClient, type CongressTradeClientConfig, CongressTradeHttpError, type CongressTransaction, type CongressTransactionRead, CongressTransactionReadSchema, CongressTransactionSchema, type ConvictionTicker, ConvictionTickerSchema, DEFAULT_CONGRESS_TRADE_BASE_URL, DEFAULT_TRANSACTIONS_LIMIT, type FundamentalRow, FundamentalRowSchema, type InsiderReadRow, InsiderReadRowSchema, type InsiderRow, InsiderRowSchema, IsoDateSchema, LAG_BUCKETS, MAX_REFS_BATCH, MKT_CAP_THRESHOLDS, type MemberLeader, MemberLeaderSchema, type MemberPerformance, MemberPerformanceSchema, type MktCapBucket, MktCapBucketSchema, type OpenRouterRequestEnrichment, type OperationGuardInFlight, OperationGuardInFlightSchema, type OperationGuardRateLimited, OperationGuardRateLimitedSchema, type OperationGuardRejection, OperationGuardRejectionSchema, type Owner, OwnerSchema, type PartyBucket, PartyBucketSchema, type PriceClose, PriceCloseSchema, type PriceSeries, PriceSeriesSchema, STOCK_ACT_BRACKETS, type SecurityRef, type SecurityRefInput, SecurityRefInputSchema, SecurityRefSchema, type SharePayload, SharePayloadSchema, type ShortVolumeReadRow, ShortVolumeReadRowSchema, type ShortVolumeRow, ShortVolumeRowSchema, type SnapshotManifest, SnapshotManifestSchema, type SnapshotTableInfo, SnapshotTableInfoSchema, type SseMessage, SseMessageSchema, SseParser, type SseParserOptions, type Subscription, SubscriptionSchema, TICKER_ACQUISITIONS, TICKER_ALIASES, TICKER_RENAMES, type TickerAliasClass, type TickerAliasResolution, type TickerBacktest, TickerBacktestSchema, type TickerLeader, TickerLeaderSchema, type TransactionsPage, TransactionsPageSchema, type TransactionsQuery, TransactionsQuerySchema, type TxType, TxTypeSchema, type UsageTelemetryBatch, type UsageTelemetryBatchInput, UsageTelemetryBatchSchema, type UsageTelemetryBillingMode, UsageTelemetryBillingModeSchema, type UsageTelemetryClientOptions, type UsageTelemetryConfidence, UsageTelemetryConfidenceSchema, type UsageTelemetryEvent, type UsageTelemetryEventInput, UsageTelemetryEventSchema, type UsageTelemetryIngestResponse, UsageTelemetryIngestResponseSchema, type UsageTelemetryLimitWindow, UsageTelemetryLimitWindowSchema, UsageTelemetryMetadataSchema, type UsageTelemetryMetricType, UsageTelemetryMetricTypeSchema, type UsageTelemetryUnit, UsageTelemetryUnitSchema, WELL_FORMED_TICKER, WINDOW_PRESETS, type Window, bracketMidpoint, buildCallClassifier, buildOperationInFlightRejection, buildRateLimitedRejection, classifyTickerAlias, clean, createCongressEvent, createUsageTelemetryClient, daysBetween, deriveUsageTelemetryIdempotencyKey, getOperationGuardHttpStatus, isIsoDate, isPlaceholderTicker, isValidBracket, isWellFormedTicker, marketCapBucket, matchBracket, mergeRefs, nearestBracket, normalizePreferredTickerVariant, normalizeSecurityRef, normalizeTicker, openrouterRequestEnrichment, parseArray, parseSafe, punctuationVariants, resolveContinuousTicker, resolvePreferredTickerFromAssetName, resolveTickerAlias, resolveTickerDeterministic, signCongressWebhook, stripPreferredSeries, telemetryEventClassifier, usageMonitorIngestUrl, verifyCongressWebhookSignature };
