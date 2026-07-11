import type { Env, User, ClientCommandType, Subscription } from '../shared/types';
import { createSubscription, updateSubscription } from '../delivery/subscriptions';
import { upsertPreferences } from './state';
import {
  asDelivery,
  ClientInputError,
  normalizeFilters,
  publicSubscription,
  validateWebhookTargetUrl,
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
    const delivery = asDelivery(input.delivery);
    const targetUrl = typeof input.targetUrl === 'string' ? input.targetUrl.trim() : null;
    if (delivery === 'webhook') validateWebhookTargetUrl(targetUrl);
    const sub = await createSubscription(env, {
      clientId: clientIdForUser(user),
      delivery,
      targetUrl: delivery === 'webhook' ? targetUrl : null,
      secret: null,
      filters: normalizeFilters(input.filters),
    });
    return { subscription: publicSubscription(sub, true) };
  }
  if (type === 'update_subscription') {
    const id = typeof input.id === 'string' ? input.id : '';
    if (!id) throw new ClientInputError('id is required');
    await getOwnedSubscription(env, user, id);
    const patch: Partial<Pick<Subscription, 'filters' | 'targetUrl' | 'active'>> = {};
    if (input.filters !== undefined) patch.filters = normalizeFilters(input.filters);
    if (input.active !== undefined) patch.active = input.active === true;
    if (input.targetUrl !== undefined) {
      const targetUrl = typeof input.targetUrl === 'string' ? input.targetUrl.trim() : null;
      if (targetUrl) validateWebhookTargetUrl(targetUrl);
      patch.targetUrl = targetUrl;
    }
    const updated = await updateSubscription(env, id, patch);
    return { subscription: publicSubscription(updated) };
  }
  throw new ClientInputError(`${type} is not implemented yet`, 501);
}
