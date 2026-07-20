# 2026-07-05 — Split `TICKER_ALIASES` into rename-vs-acquisition classes

**Seat:** MONET · **Branch:** `monet/sad-hermann-671f4d` · **Version:** 1.2.0 → **1.3.0** (additive minor)
**Board row:** "Split `TICKER_ALIASES` into rename-vs-acquisition classes (AG, M, cross-app)" —
shared-library portion (owner-directed pickup; consumer migration remains the AG follow-up).

## Summary

`TICKER_ALIASES` was a single flat `Record<string,string>` that folded two corporate-action types
that are **not interchangeable** for point-in-time (PIT) return attribution:

- A **continuous rename** — the same listed entity keeps trading under a new symbol, so its price
  series is continuous across the change (`FB→META`). Folding old→new is *correct* for backtests.
- A **delisting acquisition** — the source ticker stopped trading when it was taken over (cash
  and/or a different successor entity), so its price series **ends at the deal** (`ATVI→MSFT`,
  an all-cash acquisition where ATVI holders received cash, not MSFT shares). Folding it into the
  acquirer's ongoing series fabricates market exposure the position never had.

This change splits the map into two labeled classes and adds helpers to classify/resolve with the
distinction, **without changing any existing behavior**. It is fully backward compatible.

## Why it matters (the money path)

Congress.Trade already consumes `TICKER_ALIASES` in two places
(`/Users/jay/Code/Congress.Trade`, read-only evidence):

- `app/src/extraction/normalizer.ts:492` — identity resolution (map a stale ticker to the current
  entity in the securities master). **Both** classes are fine to fold here; no change needed.
- `app/src/export/pitScores.ts:1243,1260` — builds `delistingTickerChangeMetadata`
  (`knownPriorTickers`, `mappedToCurrentTicker`, `reason: 'curated_alias_map'`) off the **flat**
  map. This is the PIT path: it currently cannot tell an acquisition-delisting from a rename, so a
  member's pre-acquisition position in a delisted target (e.g. an `ATVI` buy) is at risk of being
  attributed to the acquirer's later price history rather than being treated as closed at the deal.

The split gives that consumer the class it needs to compute delisting metadata correctly.

## API (all additive — nothing removed or changed)

`src/constants.ts`:

```ts
export const TICKER_RENAMES: Readonly<Record<string, string>>;      // FB→META, SQ→XYZ, GEHCV→GEHC
export const TICKER_ACQUISITIONS: Readonly<Record<string, string>>; // BRCM→AVGO, TWX→WBD, ATVI→MSFT, RHT→IBM
export const TICKER_ALIASES: Readonly<Record<string, string>>;      // = { ...RENAMES, ...ACQUISITIONS } (unchanged: same 7 entries)
```

`src/types.ts`:

```ts
export type TickerAliasClass = "rename" | "acquisition";
export interface TickerAliasResolution { from: string; to: string; class: TickerAliasClass; }
```

`src/utils.ts`:

```ts
// Unchanged — identity/display resolution, folds every alias (renames AND acquisitions):
resolveTickerAlias(ticker, aliases?=TICKER_ALIASES): string

// New — returns the class + target, or null if not a known alias source:
classifyTickerAlias(ticker, opts?={renames,acquisitions}): TickerAliasResolution | null

// New — PIT-safe: folds ONLY renames, leaves acquisition sources intact:
resolveContinuousTicker(ticker, renames?=TICKER_RENAMES): string
```

Behavioral contrast that is the whole point:

| input  | `resolveTickerAlias` (identity) | `resolveContinuousTicker` (PIT-safe) | `classifyTickerAlias` |
|--------|---------------------------------|--------------------------------------|-----------------------|
| `FB`   | `META`                          | `META`                               | `{to:"META",class:"rename"}` |
| `ATVI` | `MSFT`                          | `ATVI` (unchanged — series ends)     | `{to:"MSFT",class:"acquisition"}` |
| `AAPL` | `AAPL`                          | `AAPL`                               | `null` |

## Classification rationale

| source | target | class | corporate action |
|--------|--------|-------|-------------------|
| FB   | META | rename      | Facebook, Inc. rebranded to Meta Platforms, Inc.; ticker changed 2022-06-09, same listing. |
| SQ   | XYZ  | rename      | Block, Inc. changed its ticker SQ→XYZ (2025), same entity, continuous listing. |
| GEHCV| GEHC | rename      | GE HealthCare when-issued (GEHCV) normalized to regular-way (GEHC) after the 2023 GE spin-off. |
| BRCM | AVGO | acquisition | Broadcom Corp (BRCM) was acquired by Avago (2016); BRCM delisted, Avago assumed the Broadcom name and trades as AVGO — a different pre-deal entity. |
| TWX  | WBD  | acquisition | Time Warner (TWX) acquired by AT&T (2018), delisted; the media assets later became Warner Bros. Discovery (WBD, 2022). Not a continuous listing. |
| ATVI | MSFT | acquisition | Microsoft's all-cash acquisition of Activision Blizzard (2023); ATVI delisted, holders received cash, not MSFT shares. |
| RHT  | IBM  | acquisition | IBM's all-cash acquisition of Red Hat (2019); RHT delisted. |

The axis is **price-series continuity**, not "did the name change": a rename's historical series
continues under the new symbol; an acquisition's series terminates at the effective date.

## Backward compatibility

- `TICKER_ALIASES` keeps the exact same 7 keys and mappings (it is now the union of the two class
  maps). Existing consumers (`Object.entries`, `Object.values`, `TICKER_ALIASES[k]`, the
  Congress.Trade re-export) are unaffected.
- `resolveTickerAlias` is untouched — still folds all aliases for identity resolution.
- Purely additive → **1.3.0** minor bump. No consumer needs to change to upgrade.

## Verification

- `npm run typecheck` clean · `npm run build` success (all 6 new symbols present in
  `dist/index.d.ts`) · `npm test` **263 passed** (was 237; +26 new) · `npm audit` 0 vulnerabilities.
- New tests assert: the two class maps are disjoint, their union equals `TICKER_ALIASES` (backward
  compat), every alias classifies into exactly one class with a matching target, and the
  identity-vs-PIT behavioral contrast (`resolveTickerAlias` folds acquisitions, `resolveContinuousTicker`
  does not).
- Local build-output install smoke test: `npm pack` the tarball → clean scratch install → import
  the new symbols via **CJS `require`** and **ESM named imports**; all assertions pass (including
  `resolveContinuousTicker("ATVI") === "ATVI"` vs `resolveTickerAlias("ATVI") === "MSFT"`).
- Adversarial 3-lens review (backward-compat / corporate-action classification / PIT semantics) —
  see "Adversarial review" below.

## ⚠️ This change alone does NOT fix the PIT bug — it is necessary but not sufficient

The shared library now *offers* the rename/acquisition distinction, but Congress.Trade does not yet
*use* it. The flat `TICKER_ALIASES` remains **PIT-unsafe** at the two upstream fold sites, which
resolve acquisition sources into the acquirer **before** rows are stored/scored — so
`pitScores.ts` already sees an `MSFT`/`IBM` row and uses the acquirer's ongoing series:

- `Congress.Trade/app/src/extraction/normalizer.ts:492` — `TICKER_ALIASES[t] && byTicker.has(TICKER_ALIASES[t])`
- `Congress.Trade/app/src/extraction/tickerNormalize.ts:201` — `TICKER_ALIASES[cleaned] ?? TICKER_ALIASES[base]`

Until those migrate to `resolveContinuousTicker` / `TICKER_RENAMES` (fold renames only, leave
acquisition sources distinct), the fabricated-post-delisting-exposure hazard persists. The
constants/utils doc comments now flag `TICKER_ALIASES` as identity-only / PIT-unsafe so the next
consumer author sees it.

## Owner-gated follow-up (deliberately NOT done here)

Per `AGENTS.md`, the consumer apps are read-only evidence unless the owner asks to edit them. The
remaining **AG** scope once this lands and a tag is cut:

1. **Congress.Trade upstream fold sites** — migrate `normalizer.ts:492` and `tickerNormalize.ts:201`
   off flat `TICKER_ALIASES` onto `resolveContinuousTicker` (renames only) so acquisition sources
   keep their own (ending) series instead of inheriting the acquirer's.
2. **Congress.Trade `pitScores.ts`** — map `knownPriorTickers` through `classifyTickerAlias` to tag
   each prior ticker `rename` vs `acquisition`, and set `delisted: true` for acquisitions (today it
   is hardcoded `null`). Immediate win available with the current API (class, no date needed).
3. **Socratic.Trade** — reconcile its local `ACQUISITION_SOURCES` guard against this shared map so
   the two do not drift; prefer importing the shared `TICKER_ACQUISITIONS`.
4. Paired board rows on both consumer boards.

**Richer follow-up (owner decision):** attach an **effective date** and/or a `delisted` flag to each
acquisition (on `TICKER_ACQUISITIONS` or `TickerAliasResolution`) so PIT logic knows *when* the
series ends rather than only *that* it does. Left out here to keep the change additive and avoid
committing a money-path data shape before the consumers' exact needs are pinned — flagged for the
owner. `classifyTickerAlias` currently returns `{from,to,class}` only (no date).

## Known limitations / assumptions (verified in review)

- **Single-hop, non-transitive.** `classifyTickerAlias` / `resolveContinuousTicker` do one map
  lookup, no chaining. The curated maps are intentionally non-chained (no target is also a source),
  so a compound history (rename X→Y, then Y acquired→Z) is not representable and would need a
  richer model. Not a problem for the current 7-entry set; documented so it is a deliberate bound.
- **`TWX→WBD` is a curated *current* successor, not the direct 2018 acquirer.** TWX holders
  received AT&T (`T`) stock in 2018; `WBD` is a downstream 2022 entity. The `acquisition` class is
  correct (TWX's series terminated at the 2018 close); the `to` target is the display successor.
  Mapping preserved as-is for backward compatibility — repointing it would be a `TICKER_ALIASES`
  contract change (major bump), out of scope here.

## Adversarial review

Three independent lenses reviewed the uncommitted change (one sonnet backward-compat pass, two
opus/high-effort passes on classification and PIT semantics). Consolidated result:

- **Backward compatibility — sound.** `TICKER_ALIASES` verified byte-identical in mappings (same 7
  pairs), `resolveTickerAlias` unchanged, barrel exports clean, no prototype-chain hazard
  (`constructor`/`toString`/`__proto__` → `null`), `tsc` clean, 263 tests pass. Only finding: an
  inert key-enumeration-order change (now documented as non-contractual).
- **Classification — every pair on the correct side of the axis** (rename = continuous series,
  acquisition = series terminates at the deal). Two domain-accuracy notes on acquisition
  annotations (TWX successor nuance; BRCM close date/consideration) — folded into the comments
  above; no class is wrong.
- **PIT semantics — the split is internally sound but inert until consumers migrate** (see the ⚠️
  section). Effective-date/`delisted` and single-hop chaining are documented follow-ups, not
  blockers for the current curated set.

No blocker findings. The scoped resolution (shared-lib-only + explicit PIT-unsafe flagging +
owner-gated consumer migration) matches the review's own recommended path.

## Release

Additive minor. After merge, cut the tag so consumers can pin it:

```bash
git tag v1.3.0 && git push origin v1.3.0
```

(Push/PR/tag are owner-gated — this branch is committed locally as DONE-local pending owner action,
per the fleet convention.)
