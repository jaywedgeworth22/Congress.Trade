// The Worker intentionally omits Node types, while Vitest runs this static fixture check in Node.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const fixtureUrl = new URL(
  '../../../scripts/seed-preview-fixtures.sql',
  (import.meta as ImportMeta & { url: string }).url,
);
const fixtureSql: string = readFileSync(fixtureUrl as any, 'utf8');

function splitSqlValues(tuple: string): string[] {
  const values: string[] = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < tuple.length; index += 1) {
    const character = tuple[index];
    if (character === "'" && quoted && tuple[index + 1] === "'") {
      current += "''";
      index += 1;
    } else if (character === "'") {
      quoted = !quoted;
      current += character;
    } else if (character === ',' && !quoted) {
      values.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }

  values.push(current.trim());
  return values;
}

describe('preview transaction fixtures', () => {
  it('materializes the midpoint estimate for every transaction row', () => {
    const transactionInsert = fixtureSql.match(
      /INSERT INTO transactions\s*\(([\s\S]*?)\)\s*VALUES\s*([\s\S]*?)\s*ON CONFLICT/,
    );
    expect(transactionInsert).not.toBeNull();
    if (!transactionInsert) throw new Error('preview transaction fixture INSERT is missing');

    const columns = transactionInsert[1].split(',').map((column) => column.trim());
    const rows = transactionInsert[2]
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('('))
      .map((line) => splitSqlValues(line.replace(/^\(/, '').replace(/\)[,;]?$/, '')));

    expect(rows.length).toBeGreaterThan(0);
    expect(columns).toContain('est_value');
    expect(fixtureSql).toContain('ON CONFLICT(id) DO UPDATE SET est_value = excluded.est_value');

    for (const row of rows) {
      expect(row).toHaveLength(columns.length);
      const values = Object.fromEntries(columns.map((column, index) => [column, row[index]]));
      const amountMin = Number(values.amount_min);
      const amountMax = Number(values.amount_max);
      expect(Number(values.est_value), values.id).toBe((amountMin + amountMax) / 2);
    }
  });

  it('seeds persisted benchmark history for all three branches without provider calls', () => {
    expect(fixtureSql).toContain("'PREVIEW-BENCH-HOUSE', 'house', 'completed'");
    expect(fixtureSql).toContain("'PREVIEW-BENCH-SENATE', 'senate', 'completed'");
    expect(fixtureSql).toContain("'PREVIEW-BENCH-EXEC', 'executive', 'completed'");
    expect(fixtureSql).toContain('"billing":"synthetic-preview-only"');
    expect(fixtureSql).toContain("NULL, 'unknown', '{\"reason\":\"synthetic_unknown_cost\"}'");
    expect((fixtureSql.match(/PREVIEW-BENCH-DOC-/g) ?? []).length).toBeGreaterThanOrEqual(12);
  });
});
