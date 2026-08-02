import type { Env, User, ClientCommandType, Subscription } from '../shared/types.ts';
import { isPremiumUser } from '../billing/entitlement.ts';
import {
  assertSubscriptionQuota,
  createSubscription,
  SubscriptionQuotaError,
  updateSubscription,
  webhookTargetLengthError,
} from '../delivery/subscriptions.ts';
import { localWebhookTargetsAllowed, validatePublicWebhookTarget } from '../delivery/webhookTarget.ts';
import { rateLimit } from '../shared/rateLimit.ts';
import { getCommand, updateCommandStatus, upsertPreferences } from './state.ts';
import { getUserById } from '../auth/users.ts';
import {
  asDelivery,
  ClientInputError,
  normalizeFilters,
  publicSubscription,
  arrayOfStrings,
  clientIdForUser,
} from './utils.ts';
import { getOwnedSubscription } from './queries.ts';

export function commandType(value: unknown): ClientCommandType {
  const type = String(value || '');
  if (
    type === 'update_preferences' ||
    type === 'create_subscription' ||
    type === 'update_subscription' ||
    type === 'start_checkout' ||
    type === 'request_export'
  ) {
    return type;
  }
  throw new ClientInputError('unsupported command type');
}

export function normalizePreferencePatch(input: Record<string, unknown>) {
  const patch: Parameters<typeof upsertPreferences>[2] = {};
  if (input.savedFilters !== undefined) {
    if (typeof input.savedFilters !== 'object' || Array.isArray(input.savedFilters) || input.savedFilters === null) {
      throw new ClientInputError('savedFilters must be an object');
    }
    patch.savedFilters = input.savedFilters as Record<string, unknown>;
  }
  if (input.watchlist !== undefined) patch.watchlist = arrayOfStrings(input.watchlist, { upper: true }) ?? [];
  if (input.notificationSettings !== undefined) {
    if (
      typeof input.notificationSettings !== 'object' ||
      Array.isArray(input.notificationSettings) ||
      input.notificationSettings === null
    ) {
      throw new ClientInputError('notificationSettings must be an object');
    }
    patch.notificationSettings = input.notificationSettings as Record<string, unknown>;
  }
  if (input.defaultWindow !== undefined) {
    patch.defaultWindow = input.defaultWindow == null ? null : String(input.defaultWindow);
  }
  return patch;
}

export function persistedCommandResult(type: ClientCommandType, result: unknown): unknown {
  if (type !== 'create_subscription' || !result || typeof result !== 'object' || Array.isArray(result)) {
    return result;
  }
  const root = result as { subscription?: unknown };
  if (!root.subscription || typeof root.subscription !== 'object' || Array.isArray(root.subscription)) {
    return result;
  }
  return {
    ...root,
    subscription: publicSubscription(root.subscription as Subscription),
  };
}

/** Split an executed command result into the row-safe half and the one-time credential half. */
export function splitCommandResult(
  type: ClientCommandType,
  result: unknown,
): { persisted: unknown; secret: unknown | null } {
  const persisted = persistedCommandResult(type, result);
  if (persisted === result) return { persisted, secret: null };
  const sub = ((result as { subscription?: Record<string, unknown> }).subscription ?? {});
  if (sub.secret === undefined && sub.streamUrl === undefined) return { persisted, secret: null };
  const secret: Record<string, unknown> = {};
  if (sub.secret !== undefined) secret.secret = sub.secret;
  if (sub.streamUrl !== undefined) secret.streamUrl = sub.streamUrl;
  return { persisted, secret: { subscription: secret } };
}

/** Merge a claimed one-time credential back into the redacted result for the single disclosing response. */
export function mergeClaimedSecret(result: unknown, claimed: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  if (!claimed || typeof claimed !== 'object' || Array.isArray(claimed)) return result;
  const sub = (result as { subscription?: unknown }).subscription;
  const claimedSub = (claimed as { subscription?: Record<string, unknown> }).subscription;
  if (!sub || typeof sub !== 'object' || Array.isArray(sub) || !claimedSub) return result;
  return { ...(result as Record<string, unknown>), subscription: { ...(sub as Record<string, unknown>), ...claimedSub } };
}

function subscriptionIdForCommand(commandId: string | undefined): string | undefined {
  return commandId?.startsWith('cmd_') ? `sub_${commandId.slice(4)}` : undefined;
}

export async function executeCommand(
  env: Env,
  user: User,
  type: ClientCommandType,
  payload: unknown,
  opts: { commandId?: string } = {},
): Promise<unknown> {
  const input = (payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}) as Record<string, unknown>;
  if (type === 'update_preferences') {
    return { preferences: await upsertPreferences(env, user.id, normalizePreferencePatch(input)) };
  }
  if (type === 'create_subscription') {
    if (!isPremiumUser(user)) {
      throw new ClientInputError('Creating a subscription requires a Premium account', 402);
    }
    const delivery = asDelivery(input.delivery);
    const targetUrl = typeof input.targetUrl === 'string' ? input.targetUrl.trim() : null;
    const targetLengthError = webhookTargetLengthError(targetUrl);
    if (targetLengthError) throw new ClientInputError(targetLengthError);
    if (delivery === 'webhook') {
      const targetError = await validatePublicWebhookTarget(targetUrl, {
        allowLocalhost: localWebhookTargetsAllowed(env),
      });
      if (targetError) throw new ClientInputError(targetError);
    }
    const clientId = clientIdForUser(user);
    const limited = await rateLimit(env, 'sub-create-user', clientId, 10, 3600);
    if (!limited.ok) throw new ClientInputError('too many subscription requests', 429);
    try {
      await assertSubscriptionQuota(env, clientId, { creating: true });
      const sub = await createSubscription(env, {
        id: subscriptionIdForCommand(opts.commandId),
        clientId,
        delivery,
        targetUrl: delivery === 'webhook' ? targetUrl : null,
        secret: null,
        filters: normalizeFilters(input.filters),
      });
      return { subscription: publicSubscription(sub, true) };
    } catch (err) {
      if (err instanceof SubscriptionQuotaError) throw new ClientInputError(err.message, 409);
      throw err;
    }
  }
  if (type === 'update_subscription') {
    const id = typeof input.id === 'string' ? input.id : '';
    if (!id) throw new ClientInputError('id is required');
    const existing = await getOwnedSubscription(env, user, id);
    const patch: Partial<Pick<Subscription, 'filters' | 'targetUrl' | 'active'>> = {};
    if (input.filters !== undefined) patch.filters = normalizeFilters(input.filters);
    if (input.active !== undefined) {
      patch.active = input.active === true;
      if (patch.active && !existing.active) {
        if (!isPremiumUser(user)) {
          throw new ClientInputError('Activating a subscription requires a Premium account', 402);
        }
        try {
          await assertSubscriptionQuota(env, existing.clientId, { activating: true });
        } catch (err) {
          if (err instanceof SubscriptionQuotaError) throw new ClientInputError(err.message, 409);
          throw err;
        }
      }
    }
    if (input.targetUrl !== undefined) {
      const targetUrl = typeof input.targetUrl === 'string' ? input.targetUrl.trim() : null;
      const targetLengthError = webhookTargetLengthError(targetUrl);
      if (targetLengthError) throw new ClientInputError(targetLengthError);
      if (existing.delivery === 'webhook') {
        const targetError = await validatePublicWebhookTarget(targetUrl, {
          allowLocalhost: localWebhookTargetsAllowed(env),
        });
        if (targetError) throw new ClientInputError(targetError);
      }
      patch.targetUrl = targetUrl;
    }
    try {
      const updated = await updateSubscription(env, id, patch);
      return { subscription: publicSubscription(updated) };
    } catch (err) {
      if (err instanceof SubscriptionQuotaError) throw new ClientInputError(err.message, 409);
      throw err;
    }
  }
  throw new ClientInputError(`${type} is not implemented yet`, 501);
}

/**
 * Queue-worker entrypoint for `command.execute` messages (POST
 * /api/client/v1/commands enqueues and returns 202; this runs the command).
 * Idempotent on redelivery: terminal rows are left untouched. Deterministic
 * input/entitlement failures are recorded as `failed` and acknowledged;
 * unexpected errors are rethrown so the queue retry/backoff applies.
 */
export async function executeQueuedCommand(
  env: Env,
  commandId: string,
  userId: string,
): Promise<void> {
  const command = await getCommand(env, userId, commandId);
  if (!command) return;
  if (command.status !== 'queued' && command.status !== 'running') return;
  const user = await getUserById(env, userId);
  if (!user) {
    await updateCommandStatus(env, userId, commandId, 'failed', {
      error: 'command owner not found',
    });
    return;
  }
  await updateCommandStatus(env, userId, commandId, 'running');
  try {
    const result = await executeCommand(env, user, command.type, command.payload, { commandId });
    // The secret half never enters client_commands.result: GET /commands,
    // GET /commands/:id and idempotency replay all return `result` verbatim,
    // so a credential stored there is permanently replayable. It goes to
    // result_secret, which the first owner-authenticated GET /commands/:id
    // claims and destroys (claimCommandResultSecret).
    const { persisted, secret } = splitCommandResult(command.type, result);
    await updateCommandStatus(env, userId, commandId, 'succeeded', { result: persisted, resultSecret: secret });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateCommandStatus(env, userId, commandId, 'failed', { error: message });
    if (!(err instanceof ClientInputError)) throw err;
  }
}
