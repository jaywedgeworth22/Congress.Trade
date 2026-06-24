/**
 * src/client/state.ts
 *
 * D1 helpers for the shared mobile/PWA client API. The backend owns this state:
 * clients submit commands and read status, but do not perform provider work.
 */

import type {
  ClientCommand,
  ClientCommandStatus,
  ClientCommandType,
  ClientPreferences,
  Env,
} from '../shared/types';
import { all, get, parseJson, run } from '../shared/db';
import { prefixedId } from '../shared/ids';

interface PreferencesRow {
  user_id: string;
  saved_filters: string | null;
  watchlist: string | null;
  notification_settings: string | null;
  default_window: string | null;
  updated_at: string | null;
}

export interface CommandRow {
  id: string;
  user_id: string;
  type: string;
  status: string;
  idempotency_key: string | null;
  payload: string | null;
  result: string | null;
  error: string | null;
  created_at: string | null;
  updated_at: string | null;
  started_at: string | null;
  finished_at: string | null;
}

const COMMAND_COLS =
  'id, user_id, type, status, idempotency_key, payload, result, error, created_at, updated_at, started_at, finished_at';

function mapPreferences(row: PreferencesRow | null, userId: string): ClientPreferences {
  return {
    userId,
    savedFilters: parseJson<Record<string, unknown>>(row?.saved_filters, {}),
    watchlist: parseJson<string[]>(row?.watchlist, []),
    notificationSettings: parseJson<Record<string, unknown>>(row?.notification_settings, {}),
    defaultWindow: row?.default_window ?? null,
    updatedAt: row?.updated_at ?? '',
  };
}

export function mapCommand(row: CommandRow): ClientCommand {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type as ClientCommandType,
    status: row.status as ClientCommandStatus,
    idempotencyKey: row.idempotency_key,
    payload: parseJson<unknown>(row.payload, {}),
    result: row.result ? parseJson<unknown>(row.result, null) : null,
    error: row.error,
    createdAt: row.created_at ?? '',
    updatedAt: row.updated_at ?? '',
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export async function getPreferences(env: Env, userId: string): Promise<ClientPreferences> {
  const row = await get<PreferencesRow>(
    env.DB,
    'SELECT user_id, saved_filters, watchlist, notification_settings, default_window, updated_at FROM user_preferences WHERE user_id = ?',
    [userId],
  );
  return mapPreferences(row, userId);
}

export async function upsertPreferences(
  env: Env,
  userId: string,
  patch: Partial<Pick<ClientPreferences, 'savedFilters' | 'watchlist' | 'notificationSettings' | 'defaultWindow'>>,
): Promise<ClientPreferences> {
  const existing = await getPreferences(env, userId);
  const next: ClientPreferences = {
    userId,
    savedFilters: patch.savedFilters ?? existing.savedFilters,
    watchlist: patch.watchlist ?? existing.watchlist,
    notificationSettings: patch.notificationSettings ?? existing.notificationSettings,
    defaultWindow: patch.defaultWindow !== undefined ? patch.defaultWindow : existing.defaultWindow,
    updatedAt: new Date().toISOString(),
  };
  await run(
    env.DB,
    `INSERT INTO user_preferences
       (user_id, saved_filters, watchlist, notification_settings, default_window, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       saved_filters = excluded.saved_filters,
       watchlist = excluded.watchlist,
       notification_settings = excluded.notification_settings,
       default_window = excluded.default_window,
       updated_at = excluded.updated_at`,
    [
      userId,
      JSON.stringify(next.savedFilters),
      JSON.stringify(next.watchlist),
      JSON.stringify(next.notificationSettings),
      next.defaultWindow,
      next.updatedAt,
    ],
  );
  return next;
}

export async function getCommand(env: Env, userId: string, id: string): Promise<ClientCommand | null> {
  const row = await get<CommandRow>(
    env.DB,
    `SELECT ${COMMAND_COLS} FROM client_commands WHERE id = ? AND user_id = ?`,
    [id, userId],
  );
  return row ? mapCommand(row) : null;
}

export async function findCommandByIdempotencyKey(
  env: Env,
  userId: string,
  idempotencyKey: string | null,
): Promise<ClientCommand | null> {
  if (!idempotencyKey) return null;
  const row = await get<CommandRow>(
    env.DB,
    `SELECT ${COMMAND_COLS} FROM client_commands WHERE user_id = ? AND idempotency_key = ?`,
    [userId, idempotencyKey],
  );
  return row ? mapCommand(row) : null;
}

export async function listCommands(env: Env, userId: string, limit = 20): Promise<ClientCommand[]> {
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 100);
  const rows = await all<CommandRow>(
    env.DB,
    `SELECT ${COMMAND_COLS} FROM client_commands WHERE user_id = ? ORDER BY created_at DESC LIMIT ${safeLimit}`,
    [userId],
  );
  return rows.map(mapCommand);
}

export async function createCommand(
  env: Env,
  input: {
    userId: string;
    type: ClientCommandType;
    payload: unknown;
    idempotencyKey?: string | null;
  },
): Promise<ClientCommand> {
  const now = new Date().toISOString();
  const id = prefixedId('cmd');
  await run(
    env.DB,
    `INSERT INTO client_commands
       (id, user_id, type, status, idempotency_key, payload, result, error, created_at, updated_at, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL)`,
    [
      id,
      input.userId,
      input.type,
      'queued',
      input.idempotencyKey ?? null,
      JSON.stringify(input.payload ?? {}),
      now,
      now,
    ],
  );
  const command = await getCommand(env, input.userId, id);
  if (!command) throw new Error('command insert failed');
  return command;
}

export async function updateCommandStatus(
  env: Env,
  userId: string,
  id: string,
  status: ClientCommandStatus,
  opts: { result?: unknown; error?: string | null } = {},
): Promise<ClientCommand> {
  const now = new Date().toISOString();
  const finished = status === 'succeeded' || status === 'failed' || status === 'canceled' ? now : null;
  await run(
    env.DB,
    `UPDATE client_commands
        SET status = ?,
            result = COALESCE(?, result),
            error = ?,
            updated_at = ?,
            started_at = CASE WHEN started_at IS NULL AND ? = 'running' THEN ? ELSE started_at END,
            finished_at = COALESCE(?, finished_at)
      WHERE id = ? AND user_id = ?`,
    [
      status,
      opts.result === undefined ? null : JSON.stringify(opts.result),
      opts.error ?? null,
      now,
      status,
      now,
      finished,
      id,
      userId,
    ],
  );
  const command = await getCommand(env, userId, id);
  if (!command) throw new Error('command not found');
  return command;
}
