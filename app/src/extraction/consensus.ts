/**
 * src/extraction/consensus.ts
 *
 * Pure, I/O-free consensus voting over the SAME document read by several
 * extraction models. Given each model's ParsedTx[] (the row shape produced by
 * the bake-off's runCandidateOnDoc), this module aligns rows across models on
 * the shared stable row key (ticker|date|type — {@link arbitrationRowKey}) and
 * votes every field to a majority value, so a reviewer sees exactly where the
 * models agree and where they diverge.
 *
 * Voting contract:
 *   - Rows are matched across models by arbitrationRowKey; duplicate rows within
 *     ONE model are collapsed first (keep the highest-confidence copy).
 *   - Each field (txType, transactionDate, owner, assetName, ticker) is voted
 *     independently; AMOUNT is voted as the (amountMin, amountMax) BRACKET PAIR
 *     so a min from one model is never mixed with a max from another.
 *   - A field needs a STRICT majority of the models that saw the row
 *     (votes * 2 > present) to reach a consensus value; anything short of that —
 *     a tie (1-1, 2-2) or a mere plurality — is contested with value = null.
 *   - A row seen by only a minority of the models is contested regardless of
 *     field agreement (a minority reading isn't authoritative).
 *
 * Deterministic: rows are emitted sorted by row key; model lists and dissenters
 * are sorted by model id.
 */

import type { ParsedTx } from '../shared/types';
import { arbitrationRowKey } from '../extractors/types';

/** One model's reading of the document. */
export interface ConsensusRun {
  /** Stable identifier for the model/run, e.g. "gemini:gemini-3.5-flash". */
  model: string;
  /** The rows this model extracted (pre-normalization ParsedTx). */
  rows: ParsedTx[];
}

/** The voted-on fields. AMOUNT is the (min,max) bracket, voted as one unit. */
export type ConsensusFieldName =
  | 'txType'
  | 'transactionDate'
  | 'owner'
  | 'assetName'
  | 'ticker'
  | 'amount';

/** The amount bracket, voted as a single unit (never mix a min with a max). */
export interface AmountBracket {
  amountMin: number | null;
  amountMax: number | null;
}

/** The value a model produced for a field: a string, an amount bracket, or null. */
export type FieldValue = string | AmountBracket | null;

/** A single model's value for a field, when it differs from the winner. */
export interface Dissenter {
  model: string;
  value: FieldValue;
}

/** Per-field vote outcome. */
export interface FieldConsensus {
  /** Winning value, or null when there is no strict majority (tie/plurality). */
  value: FieldValue;
  /** Models backing the winner (the largest bloc's size when contested). */
  votes: number;
  /** Models that saw this row — the electorate for the field. */
  total: number;
  /**
   * Present models whose value differs from the winner. When contested (no
   * majority), EVERY present model is listed so all competing values are shown.
   */
  dissenters: Dissenter[];
  /** True iff every present model agreed (votes === total). */
  unanimous: boolean;
}

/** How strongly the models agree on a single reconciled row. */
export type RowConsensus = 'unanimous' | 'majority' | 'contested';

export interface ConsensusRow {
  rowKey: string;
  /** Model ids that produced this row, sorted. */
  presentIn: string[];
  /** Model ids that did NOT produce this row, sorted. */
  missingFrom: string[];
  fields: Record<ConsensusFieldName, FieldConsensus>;
  rowConsensus: RowConsensus;
}

export interface ConsensusSummary {
  /** Distinct model ids that participated, sorted. */
  models: string[];
  rowsUnanimous: number;
  rowsMajority: number;
  rowsContested: number;
  /** Mean per-row agreement (votes/total) for each field, as a 0–100 percentage. */
  perFieldAgreementPct: Record<ConsensusFieldName, number>;
}

export interface ConsensusResult {
  rows: ConsensusRow[];
  summary: ConsensusSummary;
}

const FIELD_NAMES: ConsensusFieldName[] = [
  'txType',
  'transactionDate',
  'owner',
  'assetName',
  'ticker',
  'amount',
];

/** Collapse a string to its comparison form: trimmed, upper-cased, whitespace-collapsed. */
function normStr(s: string | null | undefined): string {
  return (s ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
}

/** Raw display value for a field on a row (what the model actually produced). */
function rawFieldValue(tx: ParsedTx, field: ConsensusFieldName): FieldValue {
  switch (field) {
    case 'txType':
      return tx.txType;
    case 'transactionDate':
      return tx.txDate;
    case 'owner':
      return tx.owner;
    case 'assetName':
      return tx.assetName;
    case 'ticker':
      return tx.ticker;
    case 'amount':
      return { amountMin: tx.amountMin, amountMax: tx.amountMax };
  }
}

/** Comparison key for a field value — the bracket pair is keyed as a single unit. */
function fieldVoteKey(tx: ParsedTx, field: ConsensusFieldName): string {
  if (field === 'amount') {
    return `${tx.amountMin ?? ''}|${tx.amountMax ?? ''}`;
  }
  return normStr(rawFieldValue(tx, field) as string | null);
}

/** Stable ascending comparator for model-id strings. */
function byModel(a: { model: string }, b: { model: string }): number {
  return a.model < b.model ? -1 : a.model > b.model ? 1 : 0;
}

/**
 * Collapse duplicate rows within ONE model's output, keeping the
 * highest-confidence copy (ties keep the first seen). Returns rowKey -> row.
 */
function dedupeRun(rows: ParsedTx[]): Map<string, ParsedTx> {
  const byKey = new Map<string, ParsedTx>();
  for (const tx of rows) {
    const key = arbitrationRowKey(tx);
    const existing = byKey.get(key);
    if (!existing || (tx.confidence ?? 0) > (existing.confidence ?? 0)) {
      byKey.set(key, tx);
    }
  }
  return byKey;
}

/** Vote one field across the models that saw a row. */
function voteField(
  present: Array<{ model: string; tx: ParsedTx }>,
  field: ConsensusFieldName,
): FieldConsensus {
  const total = present.length;

  // Tally votes by comparison key, remembering each key's raw value + backers.
  // Insertion order follows `present` (the runs order), so the retained raw
  // value is deterministic for identical input.
  const blocs = new Map<string, { rawValue: FieldValue; models: string[] }>();
  for (const { model, tx } of present) {
    const key = fieldVoteKey(tx, field);
    let bloc = blocs.get(key);
    if (!bloc) {
      bloc = { rawValue: rawFieldValue(tx, field), models: [] };
      blocs.set(key, bloc);
    }
    bloc.models.push(model);
  }

  // Largest bloc, ties broken by sorted vote key for determinism.
  let top: { rawValue: FieldValue; models: string[] } | null = null;
  for (const [, bloc] of [...blocs].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (!top || bloc.models.length > top.models.length) {
      top = { rawValue: bloc.rawValue, models: bloc.models };
    }
  }
  const topVotes = top ? top.models.length : 0;
  const hasMajority = topVotes * 2 > total;

  if (hasMajority && top) {
    const winners = new Set(top.models);
    const dissenters = present
      .filter((p) => !winners.has(p.model))
      .map((p) => ({ model: p.model, value: rawFieldValue(p.tx, field) }))
      .sort(byModel);
    return {
      value: top.rawValue,
      votes: topVotes,
      total,
      dissenters,
      unanimous: topVotes === total,
    };
  }

  // No strict majority -> contested: value null, every present value listed.
  const dissenters = present
    .map((p) => ({ model: p.model, value: rawFieldValue(p.tx, field) }))
    .sort(byModel);
  return { value: null, votes: topVotes, total, dissenters, unanimous: false };
}

/**
 * Build the reconciled consensus rows + summary from each model's reading of a
 * single document. Pure — no I/O.
 */
export function buildConsensusRows(runs: ConsensusRun[]): ConsensusResult {
  // Collapse duplicate model ids to a DISTINCT electorate. Two runs sharing a
  // model id (e.g. a misconfigured lineup naming the same provider:model twice)
  // must not double-count a single physical read into a false majority — the
  // present-tally below iterates `models`, and the presence/majority math uses
  // `totalRuns`, so both must be the distinct-model count. When ids collide the
  // last run's rows win (perModel is keyed by id); the earlier duplicate read is
  // dropped rather than corroborating itself.
  const models = [...new Set(runs.map((r) => r.model))];
  const totalRuns = models.length;

  // Per model: rowKey -> deduped row.
  const perModel = new Map<string, Map<string, ParsedTx>>();
  for (const run of runs) perModel.set(run.model, dedupeRun(run.rows));

  // Every row key seen by any model.
  const allKeys = new Set<string>();
  for (const rowsByKey of perModel.values()) {
    for (const k of rowsByKey.keys()) allKeys.add(k);
  }

  const fieldAgreeSum = Object.fromEntries(FIELD_NAMES.map((f) => [f, 0])) as Record<
    ConsensusFieldName,
    number
  >;
  const fieldAgreeCount = Object.fromEntries(FIELD_NAMES.map((f) => [f, 0])) as Record<
    ConsensusFieldName,
    number
  >;

  const rows: ConsensusRow[] = [];
  let rowsUnanimous = 0;
  let rowsMajority = 0;
  let rowsContested = 0;

  for (const rowKey of [...allKeys].sort()) {
    // Which models saw this row (iterate in runs order for stable bloc values).
    const present: Array<{ model: string; tx: ParsedTx }> = [];
    for (const model of models) {
      const tx = perModel.get(model)!.get(rowKey);
      if (tx) present.push({ model, tx });
    }
    const presentSet = new Set(present.map((p) => p.model));
    const presentIn = present.map((p) => p.model).sort();
    const missingFrom = models.filter((m) => !presentSet.has(m)).sort();

    const fields = {} as Record<ConsensusFieldName, FieldConsensus>;
    for (const field of FIELD_NAMES) {
      const fc = voteField(present, field);
      fields[field] = fc;
      if (fc.total > 0) {
        fieldAgreeSum[field] += fc.votes / fc.total;
        fieldAgreeCount[field] += 1;
      }
    }

    // A row must be backed by a strict majority of the models to be authoritative.
    const majorityPresence = presentIn.length * 2 > totalRuns;
    const allUnanimous = FIELD_NAMES.every((f) => fields[f].unanimous);
    // votes*2 > total is the strict-majority test; independent of the value
    // being null (a unanimous "no ticker" reading still has a majority).
    const allHaveMajority = FIELD_NAMES.every((f) => fields[f].votes * 2 > fields[f].total);

    let rowConsensus: RowConsensus;
    if (!majorityPresence) {
      rowConsensus = 'contested';
    } else if (presentIn.length === totalRuns && allUnanimous) {
      rowConsensus = 'unanimous';
    } else if (allHaveMajority) {
      rowConsensus = 'majority';
    } else {
      rowConsensus = 'contested';
    }

    if (rowConsensus === 'unanimous') rowsUnanimous += 1;
    else if (rowConsensus === 'majority') rowsMajority += 1;
    else rowsContested += 1;

    rows.push({ rowKey, presentIn, missingFrom, fields, rowConsensus });
  }

  const perFieldAgreementPct = Object.fromEntries(
    FIELD_NAMES.map((f) => [
      f,
      fieldAgreeCount[f] > 0
        ? Math.round((fieldAgreeSum[f] / fieldAgreeCount[f]) * 1000) / 10
        : 0,
    ]),
  ) as Record<ConsensusFieldName, number>;

  return {
    rows,
    summary: {
      models: [...new Set(models)].sort(),
      rowsUnanimous,
      rowsMajority,
      rowsContested,
      perFieldAgreementPct,
    },
  };
}
