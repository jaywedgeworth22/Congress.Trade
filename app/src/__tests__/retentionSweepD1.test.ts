import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import {
  runRetentionSweep,
  RETENTION_POLICIES,
  RETENTION_DELETE_BATCH,
} from '../jobs.ts';
import type { Env } from '../shared/types.ts';

let mf: Miniflare;
let db: D1Database;
let partialDb: D1Database;

/**
 * Same workerd-availability probe as reviewResolutionD1.test.ts: the
 * self-hosted deploy runner's container cannot start workerd, so skip (loudly)
 * there while every environment that can run the suite still runs every test.
 */
const workerdAvailable = await (async () => {
  try {
    const probe = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-07-07',
    });
    await probe.ready;
    await probe.dispose();
    return true;
  } catch (err) {
    console.warn(
      'retentionSweepD1.test.ts: workerd cannot start in this environment — skipping the D1 suite:',
      (err as Error).message,
    );
    return false;
  }
})();

// Mirrors app/migrations/0001_init.sql (ingest_log), 0024 (dead_letter_events),
// and 0031 (source_attempts).
const SCHEMA = `
  CREATE TABLE dead_letter_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, queue TEXT NOT NULL, msg_type TEXT,
    doc_id TEXT, tx_id TEXT, attempts INTEGER, error TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE ingest_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, polled_at TEXT NOT NULL,
    new_count INTEGER NOT NULL DEFAULT 0, first_seen_at TEXT
  );
  CREATE TABLE source_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, attempted_at TEXT NOT NULL,
    outcome TEXT NOT NULL, new_count INTEGER NOT NULL DEFAULT 0, error TEXT
  )
`;

const NOW = new Date('2026-07-18T12:00:00Z');

function daysAgoIso(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

async function count(d1: D1Database, table: string): Promise<number> {
  const row = await d1.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

beforeAll(async () => {
  if (!workerdAvailable) return;
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-07-07',
    d1Databases: ['DB', 'DB_PARTIAL'],
  });
  db = await mf.getD1Database('DB');
  await db.batch(
    SCHEMA.split(';').map((sql) => sql.trim()).filter(Boolean).map((sql) => db.prepare(sql)),
  );
  // A DB missing one retention table (fresh preview DBs can lag migrations):
  // the sweep must skip it and still prune the tables that do exist.
  partialDb = await mf.getD1Database('DB_PARTIAL');
  await partialDb.batch(
    SCHEMA.split(';')
      .map((sql) => sql.trim())
      .filter((sql) => sql && !sql.includes('source_attempts'))
      .map((sql) => partialDb.prepare(sql)),
  );
}, 30_000);

beforeEach(async () => {
  if (!workerdAvailable) return;
  await db.batch([
    db.prepare('DELETE FROM dead_letter_events'),
    db.prepare('DELETE FROM ingest_log'),
    db.prepare('DELETE FROM source_attempts'),
  ]);
});

afterAll(async () => {
  if (mf) await mf.dispose();
});

describe.runIf(workerdAvailable)('runRetentionSweep on real D1', () => {
  it('deletes only rows older than each table retention window', async () => {
    // dead_letter_events: 30d retention.
    await db.batch([
      db.prepare("INSERT INTO dead_letter_events (queue, created_at) VALUES ('q', ?)").bind(daysAgoIso(31)),
      db.prepare("INSERT INTO dead_letter_events (queue, created_at) VALUES ('q', ?)").bind(daysAgoIso(400)),
      db.prepare("INSERT INTO dead_letter_events (queue, created_at) VALUES ('q', ?)").bind(daysAgoIso(29)),
      // ingest_log: 90d retention.
      db.prepare("INSERT INTO ingest_log (source, polled_at) VALUES ('house', ?)").bind(daysAgoIso(91)),
      db.prepare("INSERT INTO ingest_log (source, polled_at) VALUES ('senate', ?)").bind(daysAgoIso(89)),
      // source_attempts: 30d retention.
      db.prepare("INSERT INTO source_attempts (source, attempted_at, outcome) VALUES ('house', ?, 'success')").bind(daysAgoIso(31)),
      db.prepare("INSERT INTO source_attempts (source, attempted_at, outcome) VALUES ('house', ?, 'failure')").bind(daysAgoIso(1)),
    ]);

    const deleted = await runRetentionSweep({ DB: db } as unknown as Env, NOW);

    expect(deleted).toEqual({ dead_letter_events: 2, ingest_log: 1, source_attempts: 1 });
    expect(await count(db, 'dead_letter_events')).toBe(1);
    expect(await count(db, 'ingest_log')).toBe(1);
    expect(await count(db, 'source_attempts')).toBe(1);
  });

  it('drains a backlog larger than one LIMIT batch and leaves fresh rows alone', async () => {
    const overOneBatch = RETENTION_DELETE_BATCH + 7;
    await db
      .prepare(
        `INSERT INTO dead_letter_events (queue, created_at)
         WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < ?)
         SELECT 'q', ? FROM cnt`,
      )
      .bind(overOneBatch, daysAgoIso(45))
      .run();
    await db
      .prepare("INSERT INTO dead_letter_events (queue, created_at) VALUES ('q', ?)")
      .bind(daysAgoIso(2))
      .run();

    const deleted = await runRetentionSweep({ DB: db } as unknown as Env, NOW);

    expect(deleted.dead_letter_events).toBe(overOneBatch);
    expect(await count(db, 'dead_letter_events')).toBe(1);
  });

  it('is a no-op (zero deletions) when nothing is out of window', async () => {
    await db.batch([
      db.prepare("INSERT INTO dead_letter_events (queue, created_at) VALUES ('q', ?)").bind(daysAgoIso(5)),
      db.prepare("INSERT INTO ingest_log (source, polled_at) VALUES ('house', ?)").bind(daysAgoIso(30)),
      db.prepare("INSERT INTO source_attempts (source, attempted_at, outcome) VALUES ('house', ?, 'success')").bind(daysAgoIso(10)),
    ]);

    const deleted = await runRetentionSweep({ DB: db } as unknown as Env, NOW);

    expect(deleted).toEqual({ dead_letter_events: 0, ingest_log: 0, source_attempts: 0 });
    expect(await count(db, 'dead_letter_events')).toBe(1);
    expect(await count(db, 'ingest_log')).toBe(1);
    expect(await count(db, 'source_attempts')).toBe(1);
  });

  it('skips a missing table without aborting the other sweeps', async () => {
    await partialDb.batch([
      partialDb.prepare("DELETE FROM dead_letter_events"),
      partialDb.prepare("DELETE FROM ingest_log"),
      partialDb.prepare("INSERT INTO dead_letter_events (queue, created_at) VALUES ('q', ?)").bind(daysAgoIso(31)),
      partialDb.prepare("INSERT INTO ingest_log (source, polled_at) VALUES ('house', ?)").bind(daysAgoIso(91)),
    ]);

    const deleted = await runRetentionSweep({ DB: partialDb } as unknown as Env, NOW);

    // source_attempts does not exist on this DB: reported as 0, no throw.
    expect(deleted).toEqual({ dead_letter_events: 1, ingest_log: 1, source_attempts: 0 });
    expect(await count(partialDb, 'dead_letter_events')).toBe(0);
    expect(await count(partialDb, 'ingest_log')).toBe(0);
  });

  it('covers every policy table in one sweep (policy list sanity)', () => {
    expect(RETENTION_POLICIES.map((p) => p.table).sort()).toEqual([
      'dead_letter_events',
      'ingest_log',
      'source_attempts',
    ]);
    // Retention windows are the contract this PR ships: 30d DLQ, 90d ingest
    // log, 30d source attempts.
    expect(
      Object.fromEntries(RETENTION_POLICIES.map((p) => [p.table, p.days])),
    ).toEqual({ dead_letter_events: 30, ingest_log: 90, source_attempts: 30 });
  });
});
