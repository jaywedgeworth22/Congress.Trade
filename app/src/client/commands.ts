import type { Env, User, ClientCommandType, Subscription } from '../shared/types';
import { isPremiumUser } from '../billing/entitlement';
import {
  assertSubscriptionQuota,
  createSubscription,
  SubscriptionQuotaError,
  updateSubscription,
  webhookTargetLengthError,
} from '../delivery/subscriptions';
import { localWebhookTargetsAllowed, validatePublicWebhookTarget } from '../delivery/webhookTarget';
import { rateLimit } from '../shared/rateLimit';
import { upsertPreferences } from './state';
import {
  asDelivery,
  ClientInputError,
  normalizeFilters,
  publicSubscription,
  arrayOfStrings,
  clientIdForUser,
} from './utils';
import { getOwnedSubscription } from './queries';

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

export async function executeCommand(env: Env, user: User, type: ClientCommandType, payload: unknown): Promise<unknown> {
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
