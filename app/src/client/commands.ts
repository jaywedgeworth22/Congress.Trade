import type { Env, User, ClientCommandType, Subscription } from '../shared/types.ts';
import { isPremiumUserAsync, resolveEntitlementAsync } from '../billing/entitlement.ts';
import {
  assertSubscriptionQuota,
  createSubscription,
  deleteSubscription,
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
import {
  asPushPlatform,
  deactivatePushDevice,
  publicPushDevice,
  upsertPushDevice,
} from './pushDevices.ts';
import { verifyAppleSignedJws, AppleJwsVerificationError } from '../billing/appleJws.ts';
import {
  appleSandboxPurchasesAllowed,
  appleTransactionIsActive,
  isAppleSandboxEnvironment,
  planFromConfiguredAppleProductId,
  resolveAppleProductIds,
  type AppleTransactionPayload,
} from '../billing/apple.ts';
import { upsertAppleSubscription } from '../billing/appleSubscriptions.ts';
import { resolveSecret } from '../secrets/infisical.ts';
import { deleteUserAccount } from '../auth/deleteAccount.ts';

export function commandType(value: unknown): ClientCommandType {
  const type = String(value || '');
  if (
    type === 'update_preferences' ||
    type === 'create_subscription' ||
    type === 'update_subscription' ||
    type === 'delete_subscription' ||
    type === 'register_device' ||
    type === 'unregister_device' ||
    type === 'start_checkout' ||
    type === 'request_export' ||
    type === 'redeem_apple_purchase' ||
    type === 'delete_account'
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
    // Legacy iOS builds registered APNs via create_subscription + delivery:'apns'.
    // That is not a webhook/SSE channel — rewrite to the device-registration path
    // so production tokens stop failing with "delivery must be 'sse' or 'webhook'".
    if (input.delivery === 'apns' || input.delivery === 'ios' || input.delivery === 'push') {
      return executeCommand(env, user, 'register_device', {
        platform: 'apns',
        token: input.targetUrl ?? input.token ?? input.deviceToken,
        appBundle: input.appBundle,
        env: input.env,
      }, opts);
    }
    if (!(await isPremiumUserAsync(env, user))) {
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
        if (!(await isPremiumUserAsync(env, user))) {
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
  if (type === 'delete_subscription') {
    const id = typeof input.id === 'string' ? input.id : '';
    if (!id) throw new ClientInputError('id is required');
    // Ownership check (404 if missing / not owned). Delete is allowed for
    // signed-in owners even without Premium so cancelled accounts can clean up.
    await getOwnedSubscription(env, user, id);
    const deleted = await deleteSubscription(env, id);
    if (!deleted) throw new ClientInputError('subscription not found', 404);
    return { deleted: true, id };
  }
  if (type === 'register_device') {
    // Device registration is signed-in only (not Premium-gated). Actual trade
    // push fan-out still requires Premium + APNs credentials when that path
    // ships — storing the token early means upgrade → push without re-prompt.
    let platform;
    try {
      platform = asPushPlatform(input.platform ?? input.delivery ?? 'apns');
    } catch (err) {
      throw new ClientInputError(err instanceof Error ? err.message : String(err));
    }
    const tokenRaw =
      (typeof input.token === 'string' && input.token) ||
      (typeof input.targetUrl === 'string' && input.targetUrl) ||
      (typeof input.deviceToken === 'string' && input.deviceToken) ||
      '';
    const limited = await rateLimit(env, 'device-register-user', user.id, 30, 3600);
    if (!limited.ok) throw new ClientInputError('too many device registration requests', 429);
    try {
      const device = await upsertPushDevice(env, {
        userId: user.id,
        platform,
        token: tokenRaw,
        appBundle: typeof input.appBundle === 'string' ? input.appBundle : null,
        env: typeof input.env === 'string' ? input.env : null,
      });
      return { device: publicPushDevice(device) };
    } catch (err) {
      throw new ClientInputError(err instanceof Error ? err.message : String(err));
    }
  }
  if (type === 'unregister_device') {
    const limited = await rateLimit(env, 'device-unregister-user', user.id, 30, 3600);
    if (!limited.ok) throw new ClientInputError('too many device unregister requests', 429);
    let platform;
    try {
      platform = input.platform !== undefined || input.delivery !== undefined
        ? asPushPlatform(input.platform ?? input.delivery)
        : undefined;
    } catch (err) {
      throw new ClientInputError(err instanceof Error ? err.message : String(err));
    }
    const token =
      (typeof input.token === 'string' && input.token) ||
      (typeof input.targetUrl === 'string' && input.targetUrl) ||
      (typeof input.deviceToken === 'string' && input.deviceToken) ||
      undefined;
    const id = typeof input.id === 'string' ? input.id : undefined;
    if (!id && !token) throw new ClientInputError('id or token is required');
    try {
      const deactivated = await deactivatePushDevice(env, {
        userId: user.id,
        id,
        token,
        platform,
      });
      if (!deactivated) throw new ClientInputError('device not found', 404);
      return { deactivated: true, id: id ?? null };
    } catch (err) {
      if (err instanceof ClientInputError) throw err;
      throw new ClientInputError(err instanceof Error ? err.message : String(err));
    }
  }
  if (type === 'redeem_apple_purchase') {
    const enabled = (await resolveSecret(env, 'APPLE_IAP_ENABLED')).value === 'true';
    if (!enabled) throw new ClientInputError('Apple in-app purchases are not enabled yet', 503);

    const jws =
      (typeof input.signedTransaction === 'string' && input.signedTransaction) ||
      (typeof input.jwsRepresentation === 'string' && input.jwsRepresentation) ||
      '';
    if (!jws) throw new ClientInputError('signedTransaction is required');

    let transaction: AppleTransactionPayload;
    try {
      transaction = await verifyAppleSignedJws<AppleTransactionPayload>(jws);
    } catch (err) {
      const message = err instanceof AppleJwsVerificationError ? err.message : 'invalid Apple transaction';
      throw new ClientInputError(message);
    }

    const expectedBundle = (await resolveSecret(env, 'APPLE_BUNDLE_ID')).value?.trim() || 'trade.congress.ios';
    if (transaction.bundleId && transaction.bundleId !== expectedBundle) {
      throw new ClientInputError('bundleId mismatch');
    }
    if (isAppleSandboxEnvironment(transaction.environment) && !(await appleSandboxPurchasesAllowed(env))) {
      throw new ClientInputError('Sandbox Apple purchases are not accepted');
    }
    const configuredProducts = await resolveAppleProductIds(env);
    const plan = planFromConfiguredAppleProductId(transaction.productId, configuredProducts);
    if (!plan) throw new ClientInputError('unrecognized Apple product id');
    if (!appleTransactionIsActive(transaction)) {
      throw new ClientInputError('this Apple transaction is not an active subscription');
    }
    const originalTransactionId = transaction.originalTransactionId || transaction.transactionId;
    if (!originalTransactionId) throw new ClientInputError('missing Apple transaction id');

    const upserted = await upsertAppleSubscription(env, {
      originalTransactionId,
      userId: user.id,
      productId: transaction.productId ?? '',
      plan,
      status: 'active',
      environment: transaction.environment ?? null,
      latestTransactionId: transaction.transactionId ?? null,
      purchaseDate: transaction.purchaseDate != null ? new Date(Number(transaction.purchaseDate)).toISOString() : null,
      expiresDate: transaction.expiresDate != null ? new Date(Number(transaction.expiresDate)).toISOString() : null,
    });
    if (!upserted.ok) {
      // Never silently reassign a subscription's Premium grant to a new
      // account — restore-purchases on a shared/second Apple ID should
      // surface as a conflict, not a takeover of the original owner's Premium.
      throw new ClientInputError('this Apple subscription is already linked to a different account', 409);
    }

    const refreshedUser = await getUserById(env, user.id);
    const entitlement = await resolveEntitlementAsync(env, refreshedUser);
    return {
      entitlement,
      plan: upserted.record.plan,
      expiresAt: upserted.record.expiresDate,
      originalTransactionId: upserted.record.originalTransactionId,
    };
  }
  if (type === 'delete_account') {
    return deleteUserAccount(env, user, { keepCommandId: opts.commandId });
  }
  throw new ClientInputError(`${type} is not implemented yet`, 501);
}

/**
 * How long POST /api/client/v1/commands will hold a request open trying to
 * finish the command inline before handing it back to the durable queue and
 * answering 202. Must stay comfortably under the iOS client's 20s per-request
 * timeout (`APIClient.makeRequest`) — a budget that outlives the socket buys
 * nothing and costs the caller a transport error instead of a status.
 */
export const INLINE_COMMAND_BUDGET_MS = 9_000;

/**
 * Queue-worker entrypoint for `command.execute` messages. Also the inline
 * fast path: POST /api/client/v1/commands enqueues the durable backstop, then
 * calls this directly so a human waiting on a screen gets a terminal status in
 * one round trip instead of waiting out the background tick.
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
