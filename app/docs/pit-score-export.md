# Point-in-Time Congress Score Export

App B historical validation should use the token-gated export endpoint:

```http
GET /api/export/congress-pit-scores?from=2026-01-01&to=2026-06-30&limit=500&format=json
Authorization: Bearer <INGEST_TOKEN>
```

Use `format=ndjson` for one JSON object per line.

For multi-page backfills, pass the returned `pagination.nextCursor`:

```http
GET /api/export/congress-pit-scores?from=2026-01-01&to=2026-06-30&limit=500&cursor=2026-01-02T00:00:00.000Z~AAPL
Authorization: Bearer <INGEST_TOKEN>
```

JSON responses include `pagination.nextCursor`; NDJSON responses expose the same
value in the `x-next-cursor` header. The cursor is ordered by `(asOf, ticker)`.
JSON responses also include `validationReadiness`, an export-level summary of
whether returned rows are safe for historical validation.

## Contract

Rows are keyed by ticker and market-available disclosure timestamp:

- `observationId`
- `ticker`, `stableSecurityId`, `cusip`, `cik`
- raw/security asset context: `assetType`, `assetTypeName`
- cross-chamber canonical asset context: `assetTypeCategory`,
  `assetTypeCategoryLabel`, `assetTypeCategorySource`
- `tickerMapVersion`, `delistingTickerChangeMetadata`
- `asOf`, `disclosureAvailableAt`, `computedAt`, `dataCutoffAt`
- `scoreVersion`, `parameterManifest`
- `direction`, `congressScore`, `signedScore`
- `components[]`
- `rawInputs`, `provenance`, `pitValidity`
- `includedDisclosures[]`
- `memberSkill`
- `clusterConsensus`
- `committeeSectorOverlap`
- `labels`
- `baselines`
- `placebo`

`asOf` / `disclosureAvailableAt` use the filing's `first_seen_at` when present,
falling back to filed date or transaction creation time. The trade date is only
a raw disclosure field and is never the score timestamp.

## Historical Validation Readiness

This endpoint is a PIT-shaped score export, but not every row is a true
historical validation row. App B should gate historical backtests on
`pitValidity.historicalValidationReady` or the response-level
`validationReadiness`.

Row-level `pitValidity` includes:

- `historicalValidationReady`
- `scoreInputsPitSafe`
- `metadataPitComplete`
- `recommendedUse`
- `reasonCodes`
- `availabilitySources`
- `availabilityPrecisions`
- `disclosureSources`

Current rule:

- `scoreInputsPitSafe` is true only when all disclosures in the observation are
  primary rows with timestamp-level `first_seen_at` captured by Congress.Trade.
- `historicalValidationReady` is currently expected to be false for every row
  until Congress.Trade stores the metadata vintages below. Primary timestamped
  rows may still have `scoreInputsPitSafe=true`.
- Seed/imported rows, date-only availability, or rows whose availability is
  reconstructed from filed date or transaction creation time are neither
  score-input PIT-safe nor historical-validation ready.
- `metadataPitComplete` is false until Congress.Trade stores point-in-time
  security-reference, ticker-map, filer/committee/party, corporate-action, and
  no-signal universe vintages.

Practical implication: rows with `historicalValidationReady=false` are suitable
for contract tests, exploratory analysis, or live-forward collection dry runs.
They should not be treated as a real historical validation set. App B may use
`scoreInputsPitSafe=true` rows to test scoring mechanics, but must not report
historical performance from them as validation truth.

## Score Inputs

The score version is `congress-pit-v2`.

Weights:

```json
{
  "consensus": 0.35,
  "flow": 0.20,
  "freshness": 0.15,
  "member_skill": 0.20,
  "committee_sector_overlap": 0
}
```

`committee_sector_overlap` is exported as context only until Congress.Trade has
point-in-time committee/security-reference vintages and the feature validates on
its own. It is not currently allowed to lift the score.

Each component carries:

- `name`
- `value`
- `weight`
- `basis`: `sourced`, `computed`, `inferred`, or `missing`
- `fallback`
- `sourceRecordIds`

## No-Leakage Politician Skill

Politician skill is point-in-time. At each observation `asOf`, it uses only prior
disclosures for the involved filers where the evaluation horizon had already
matured before that `asOf`.

Politician skill is split along three axes:

- basis: filing-date basis and trade-date basis
- direction: buy and sell
- horizon: `1m`, `3m`, `6m`, `12m`

Current politician-skill horizons and weights:

```json
{
  "1m": { "days": 21, "weight": 0.20 },
  "3m": { "days": 63, "weight": 0.35 },
  "6m": { "days": 126, "weight": 0.25 },
  "12m": { "days": 252, "weight": 0.20 }
}
```

Top-level `memberSkill` includes:

- `skillScore`
- `filingAlpha`
- `tradeAlpha`
- `decayRatio`
- `skillAsOf`
- `skillScoredThrough`
- `trainingWindow`
- `trainingWindowDetails`
- `horizonWeights`
- `scoredCount`
- `shrinkagePrior`
- `dispersionWinsorization`
- `byBasis`
- `byDirection`
- `horizons`
- `sourceRecordIds`

`filingAlpha` is the direction-adjusted excess return measured from the market
availability date. `tradeAlpha` is the same calculation measured from the
reported trade date, but only after that disclosure was market-available and
only when the evaluation horizon had matured before `asOf`. The score component
uses filing-date alpha first because that is the tradable, market-available
basis. When a disclosure only has date-level availability, filing-date skill uses
the next calendar day as the conservative actionable entry date.

For sales, alpha is direction-adjusted: underperformance after a disclosed sale
counts as positive sale skill. Dispersion is reported as sample standard
deviation of direction-adjusted excess returns. Winsorization is per
basis/direction/horizon at the 5th/95th percentile when there are at least 20
observations; smaller samples are left un-winsorized and still carry the method
metadata.

If no matured labels exist, `skillScore` is null and the component falls back to
`activity_prominence`. This is marked as `basis:"inferred"`, not computed skill.
The training window is capped at the newest 1,000 eligible prior disclosed
transactions per observation; the cap and selection rule are repeated in
`memberSkill.trainingWindowDetails`.

## Cluster Consensus

`clusterConsensus` keeps the original current-observation counts and now also
exports rolling market-available disclosure windows:

- `21d_1m`
- `63d_3m`

Each window includes:

- `directionalDistinctMemberCounts`: buy, sell, net
- `qualityWeightedClusterScore`
- `agreementRatio`
- `partyBreadth`
- `chamberBreadth`
- `weightedDirectionTotals`
- `tradeCount`, `startDate`, `endDate`

Per-politician cap and diminishing-return assumptions are included under
`clusterConsensus.perMemberCapsAndDiminishingReturns`. Each politician can contribute
at most `1.0` per direction per window. Contribution is quality-weighted by
transaction confidence and bracket midpoint, then the cluster score applies a
log diminishing return to dominant-side distinct politician count.

## Labels

Labels are outcomes for validation and are not used in score inputs.

Current horizons:

- `1d`
- `5d`
- `21d`
- `63d`
- `126d`
- `252d`

Basis:

- `adjusted_close_from_price_eod`
- horizon basis: `trading_days`
- benchmark: `spx_eod`
- entry price: first close on or after the conservative actionable date

Each row exports `availabilitySource`, `availabilityPrecision`, and
`conservativeLabelEntryDate` under `rawInputs`, and each disclosure repeats
`availabilitySource` / `availabilityPrecision`. If the export only has a
date-level filed date, labels use the next calendar day before selecting the
first available close.

`labels` also includes `priceDataThrough` and `benchmarkDataThrough` so App B can
audit label reproducibility.

If the forward close is unavailable, the horizon returns null fields with
`missingLabelReason`.

Corporate-action vintage is currently null because there is no corporate-action
event table yet.

## Null And Placebo Exports

Pass `placebo=`:

- `none`
- `within_date_score_permutation`
- `member_shuffle`
- `disclosure_date_jitter`
- `buy_sell_flip`
- `no_member_skill`
- `no_freshness`
- `no_flow`
- `activity_only_proxy`
- `future_shift_leakage_detector`
- `split_dividend_event_stress_subset`

`split_dividend_event_stress_subset` currently returns no rows with a note,
because Congress.Trade does not yet store split/dividend event vintages.

## Known Null Fields

These fields are intentionally present but null until source data exists:

- CUSIP
- full ticker-change / delisting event history
- corporate-action vintage
- App B pre-Congress scan score and factor set
- no-signal universe rows
- point-in-time committee/security reference vintages; current committee/sector
  metadata is marked context-only

App B should treat these as missing source data, not zero.
