/**
 * src/shared/db.ts
 * Typed D1 helper wrappers used by stubs and implemented modules.
 * Thin, dependency-free conveniences around the D1 prepared-statement API.
 */

import type { Env } from './types';
import { recordD1Meta } from './d1Budget';

export type SqlParam = string | number | boolean | null | ArrayBuffer;

function bindParams(stmt: D1PreparedStatement, params: SqlParam[]): D1PreparedStatement {
  return params.length ? stmt.bind(...(params as unknown[])) : stmt;
}

/** Fetch a single row (or null) mapped to T. */
export async function get<T = Record<string, unknown>>(
  db: D1Database,
  sql: string,
  params: SqlParam[] = [],
): Promise<T | null> {
  const stmt = bindParams(db.prepare(sql), params);
  const row = await stmt.first<T>();
  return row ?? null;
}

/** Fetch all rows mapped to T[]. */
export async function all<T = Record<string, unknown>>(
  db: D1Database,
  sql: string,
  params: SqlParam[] = [],
): Promise<T[]> {
  const stmt = bindParams(db.prepare(sql), params);
  const res = await stmt.all<T>();
  recordD1Meta(res?.meta);
  return res?.results ?? [];
}

/** Execute a write (INSERT/UPDATE/DELETE) and return the D1 meta result. */
export async function run(
  db: D1Database,
  sql: string,
  params: SqlParam[] = [],
): Promise<D1Result> {
  const stmt = bindParams(db.prepare(sql), params);
  const res = await stmt.run();
  recordD1Meta(res?.meta);
  return res;
}

/**
 * Run multiple prepared statements atomically via D1 batch.
 * Each entry is [sql, params]. Returns the array of results.
 */
export async function batch(
  db: D1Database,
  statements: Array<[string, SqlParam[]]>,
): Promise<D1Result[]> {
  const prepared = statements.map(([sql, params]) => bindParams(db.prepare(sql), params));
  if (typeof db.batch === 'function') {
    const results = await db.batch(prepared);
    for (const r of results ?? []) recordD1Meta(r?.meta);
    return results;
  }

  // Fallback for mock environments (e.g., vitest without db.batch implemented)
  const results: D1Result[] = [];
  for (const stmt of prepared) {
    const r = await stmt.run();
    recordD1Meta(r?.meta);
    results.push(r);
  }
  return results;
}

/** Convenience accessor so callers can pass `env` instead of `env.DB`. */
export function dbOf(env: Env): D1Database {
  return env.DB;
}

/** Parse a JSON text column safely, returning a fallback on null/invalid. */
export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** SQLite stores booleans as 0/1; coerce to a real boolean. */
export function toBool(value: unknown): boolean {
  return value === 1 || value === '1' || value === true;
}

/** Coerce a boolean to SQLite integer form. */
export function fromBool(value: boolean): number {
  return value ? 1 : 0;
}
