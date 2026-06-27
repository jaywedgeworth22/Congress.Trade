# Point-in-Time Congress Score Export

App B historical validation should use the token-gated export endpoint:

```http
GET /api/export/congress-pit-scores?from=2026-01-01&to=2026-06-30&limit=500&format=json
Authorization: Bearer <INGEST_TOKEN>
```

Use `format=ndjson` for one JSON object per line.

## Contract

Rows are keyed by ticker and market-available disclosure timestamp:

- `observationId`
- `ticker`, `stableSecurityId`, `cusip`, `cik`, `assetType`
- `tickerMapVersion`, `delistingTickerChangeMetadata`
- `asOf`, `disclosureAvailableAt`, `computedAt`, `dataCutoffAt`
- `scoreVersion`, `parameterManifest`
- `direction`, `congressScore`, `signedScore`
- `components[]`
- `rawInputs`, `provenance`
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

## Score Inputs

The score version is `congress-pit-v1`.

Weights:

```json
{
  "consensus": 0.35,
  "flow": 0.20,
  "freshness": 0.15,
  "member_skill": 0.20,
  "committee_sector_overlap": 0.10
}
```

Each component carries:

- `name`
- `value`
- `weight`
- `basis`: `sourced`, `computed`, `inferred`, or `missing`
- `fallback`
- `sourceRecordIds`

## No-Leakage Member Skill

Member skill is point-in-time. At each observation `asOf`, it uses only prior
disclosures for the involved filers where the evaluation horizon had already
matured before that `asOf`.

Current member-skill horizon:

- `63` calendar days after the prior disclosure availability date.

If no matured labels exist, `skillScore` is null and the component falls back to
`activity_prominence`. This is marked as `basis:"inferred"`, not computed skill.

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
- benchmark: `spx_eod`
- entry price: close on or before `disclosureAvailableAt`

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

App B should treat these as missing source data, not zero.
