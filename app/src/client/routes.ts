/**
 * src/client/routes.ts
 *
 * Shared backend-owned API for the phone-first PWA and SwiftUI app.
 * Mounted at /api/client/v1. Public reads stay public; preferences and commands
 * require the existing opaque session via cookie or Authorization bearer.
 */

import { Hono } from 'hono';
import type { ClientCommand, Env, User, ClientCommandType } from '../shared/types.ts';

import { getCurrentUserFromRequest } from '../auth/session.ts';
import { entitlementOf } from '../billing/entitlement.ts';
import { normalizeTickerLogoSymbol } from '../ui/tickerLogos.ts';
import {
  createCommand,
  DuplicateCommandError,
  findCommandByIdempotencyKey,
  getCommand,
  getPreferences,
  isStaleInFlightCommand,
  listCommands,
  reclaimStaleInFlightCommand,
  updateCommandStatus,
  upsertPreferences,
} from './state.ts';
import {
  ClientInputError,
  errorStatus,
  readJson,
  requireUser,
  filtersFromQuery,
  detailLimit,
  asOrder,
  num,
  baseSummary,
  securityRef,
  memberProfile,
  parseIntOrUndef,
  publicSubscription,
} from './utils.ts';
import {
  getClientTrade,
  getSecurityRef,
  listUserSubscriptions,
  memberSummarySql,
  readClientTradeList,
  resolveMember,
  tickerSummarySql,
} from './queries.ts';
import { commandType, executeCommand, normalizePreferencePatch, persistedCommandResult } from './commands.ts';
import { checkRowBudget, spendRowBudget } from '../security/botDefense.ts';
import { clientIp } from '../shared/rateLimit.ts';
import { get, all } from '../shared/db.ts';
import { buildMemberPerformanceQuery } from '../analytics/builders.ts';
import { aggregateMemberPerformance } from '../analytics/compute.ts';
import { latestSpxClose } from '../prices/service.ts';
import type { TradeSummaryRow } from './types.ts';
import type { TxQueryParams } from '../delivery/rows.ts';

export function buildClientRouter(): Hono<{ Bindings: Env }> {
  const r = new Hono<{ Bindings: Env }>();

  r.get('/bootstrap', async (c) => {
    const user = await getCurrentUserFromRequest(c);
    return c.json({
      serverTime: new Date().toISOString(),
      auth: {
        user: user
          ? { id: user.id, email: user.email, name: user.name, picture: user.picture }
          : null,
        entitlement: entitlementOf(user),
      },
      capabilities: {
        feed: true,
        sse: true,
        webhooks: Boolean(user),
        commands: Boolean(user),
        preferences: Boolean(user),
      },
      endpoints: {
        feed: '/api/client/v1/feed',
        trade: '/api/client/v1/trade/:id',
        ticker: '/api/client/v1/ticker/:ticker',
        member: '/api/client/v1/member/:memberIdOrName',
        commands: '/api/client/v1/commands',
        preferences: '/api/client/v1/preferences',
        subscriptions: '/api/client/v1/subscriptions',
      },
    });
  });

  r.get('/me', async (c) => {
    const user = await getCurrentUserFromRequest(c);
    return c.json({ user, entitlement: entitlementOf(user) });
  });

  r.get('/feed', async (c) => {
    const params = filtersFromQuery(c.req.query());
    // Same anti-scrape daily row budget as /api/transactions — both pagers
    // walk the identical corpus, so they draw on one shared per-IP budget.
    const ip = clientIp(c.req.raw);
    const budget = await checkRowBudget(c.env, ip);
    if (!budget.ok) {
      return c.json({ error: 'daily feed row budget reached' }, 429, {
        'Retry-After': String(budget.retryAfterSec),
      });
    }
    const list = await readClientTradeList(c.env, params);
    await spendRowBudget(c.env, ip, list.count);
    return c.json({ ...list, nextPollAfterSec: 60 });
  });

  r.get('/trade/:id', async (c) => {
    const id = (c.req.param('id') || '').trim();
    if (!id || id.length > 128) return c.json({ error: 'invalid trade id' }, 400);
    // Same per-IP daily row budget as /feed — a detail endpoint is still a
    // corpus read and must not be a free side-channel around the pager budget.
    const ip = clientIp(c.req.raw);
    const budget = await checkRowBudget(c.env, ip);
    if (!budget.ok) {
      return c.json({ error: 'daily feed row budget reached' }, 429, {
        'Retry-After': String(budget.retryAfterSec),
      });
    }
    const item = await getClientTrade(c.env, id);
    if (!item) return c.json({ error: 'trade not found' }, 404);
    await spendRowBudget(c.env, ip, 1);
    return c.json({
      item,
      items: [item],
      cursor: item.cursor,
      count: 1,
      total: 1,
      limit: 1,
    });
  });

  r.get('/ticker/:ticker', async (c) => {
    const ticker = normalizeTickerLogoSymbol(c.req.param('ticker'));
    if (!ticker) return c.json({ error: 'invalid ticker' }, 400);
    const ip = clientIp(c.req.raw);
    const budget = await checkRowBudget(c.env, ip);
    if (!budget.ok) {
      return c.json({ error: 'daily feed row budget reached' }, 429, {
        'Retry-After': String(budget.retryAfterSec),
      });
    }
    const params: TxQueryParams = {
      ticker,
      limit: detailLimit(c.req.query('limit')),
      order: asOrder(c.req.query('order')) ?? 'desc',
    };
    const summaryQ = tickerSummarySql(ticker);
    const [list, summaryRow, refRow] = await Promise.all([
      readClientTradeList(c.env, params),
      get<TradeSummaryRow>(c.env.DB, summaryQ.sql, summaryQ.params),
      getSecurityRef(c.env, ticker),
    ]);
    await spendRowBudget(c.env, ip, list.count);
    return c.json({
      ticker,
      asset: securityRef(ticker, refRow),
      summary: {
        ...baseSummary(summaryRow),
        memberCount: num(summaryRow?.member_count),
      },
      ...list,
    });
  });

  r.get('/member/:memberIdOrName', async (c) => {
    const memberIdOrName = (c.req.param('memberIdOrName') || '').trim();
    if (!memberIdOrName || memberIdOrName.length > 120) {
      return c.json({ error: 'invalid member id or name' }, 400);
    }
    const ip = clientIp(c.req.raw);
    const budget = await checkRowBudget(c.env, ip);
    if (!budget.ok) {
      return c.json({ error: 'daily feed row budget reached' }, 429, {
        'Retry-After': String(budget.retryAfterSec),
      });
    }
    const resolved = await resolveMember(c.env, memberIdOrName);
    if (!resolved) return c.json({ error: 'member not found' }, 404);
    const params: TxQueryParams = {
      member: resolved.id,
      limit: detailLimit(c.req.query('limit')),
      order: asOrder(c.req.query('order')) ?? 'desc',
    };
    const summaryQ = memberSummarySql(resolved.id);
    const perfQ = buildMemberPerformanceQuery(resolved.id, { window: 'all' });
    const [list, summaryRow, perfRowsRaw, currentSpx] = await Promise.all([
      readClientTradeList(c.env, params),
      get<TradeSummaryRow>(c.env.DB, summaryQ.sql, summaryQ.params),
      all<Record<string, unknown>>(c.env.DB, perfQ.sql, perfQ.params),
      latestSpxClose(c.env),
    ]);
    if (!resolved.profile && list.total === 0) return c.json({ error: 'member not found' }, 404);
    await spendRowBudget(c.env, ip, list.count);

    const perfRows = perfRowsRaw.map((row) => ({
      isOption: num(row.is_option) === 1,
      priceAtTrade: row.price_at_trade == null ? null : num(row.price_at_trade),
      spxAtTrade: row.spx_at_trade == null ? null : num(row.spx_at_trade),
      currentPrice: row.current_price == null ? null : num(row.current_price),
    }));
    const performance = aggregateMemberPerformance(perfRows, currentSpx);

    return c.json({
      member: memberProfile(resolved.profile, resolved.id),
      summary: {
        ...baseSummary(summaryRow),
        uniqueTickers: num(summaryRow?.unique_tickers),
        uniqueAssets: num(summaryRow?.unique_assets),
        performance,
      },
      ...list,
    });
  });

  r.get('/preferences', async (c) => {
    try {
      const user = await requireUser(c);
      return c.json({ preferences: await getPreferences(c.env, user.id) });
    } catch (err) {
      const e = err as ClientInputError;
      return c.json({ error: e.message }, errorStatus(e));
    }
  });

  r.put('/preferences', async (c) => {
    try {
      const user = await requireUser(c);
      const body = await readJson(c);
      return c.json({ preferences: await upsertPreferences(c.env, user.id, normalizePreferencePatch(body)) });
    } catch (err) {
      const e = err as ClientInputError;
      return c.json({ error: e.message }, errorStatus(e));
    }
  });

  r.get('/subscriptions', async (c) => {
    try {
      const user = await requireUser(c);
      const subs = await listUserSubscriptions(c.env, user);
      return c.json({ subscriptions: subs.map((sub) => publicSubscription(sub)) });
    } catch (err) {
      const e = err as ClientInputError;
      return c.json({ error: e.message }, errorStatus(e));
    }
  });

  r.get('/commands', async (c) => {
    try {
      const user = await requireUser(c);
      return c.json({ commands: await listCommands(c.env, user.id, parseIntOrUndef(c.req.query('limit')) ?? 20) });
    } catch (err) {
      const e = err as ClientInputError;
      return c.json({ error: e.message }, errorStatus(e));
    }
  });

  r.get('/commands/:id', async (c) => {
    try {
      const user = await requireUser(c);
      const command = await getCommand(c.env, user.id, c.req.param('id'));
      if (!command) return c.json({ error: 'command not found' }, 404);
      return c.json({ command });
    } catch (err) {
      const e = err as ClientInputError;
      return c.json({ error: e.message }, errorStatus(e));
    }
  });

  r.post('/commands', async (c) => {
    let user: User;
    let body: Record<string, unknown>;
    try {
      user = await requireUser(c);
      body = await readJson(c);
    } catch (err) {
      const e = err as ClientInputError;
      return c.json({ error: e.message }, errorStatus(e));
    }

    let type: ClientCommandType;
    try {
      type = commandType(body.type ?? body.kind);
    } catch (err) {
      const e = err as ClientInputError;
      return c.json({ error: e.message }, errorStatus(e));
    }

    const payload = body.payload ?? body.input ?? {};
    const idempotencyKey =
      (typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()) ||
      c.req.header('Idempotency-Key') ||
      null;

    // Replay by idempotency key. A terminal (succeeded/failed/canceled) row is
    // always a valid, permanent replay target. A queued/running row is only
    // replayed while it's plausibly still being executed by whichever request
    // created it (isStaleInFlightCommand — see state.ts); once it's sat past
    // that TTL with no terminal status, the owning request is presumed dead
    // and we fall through to reclaim + re-run the same row below instead of
    // replaying a status that can never change.
    const existing = await findCommandByIdempotencyKey(c.env, user.id, idempotencyKey);
    if (existing && !isStaleInFlightCommand(existing)) {
      return c.json({ command: existing, replayed: true }, 200);
    }

    let command: ClientCommand;
    let executionType = type;
    let executionPayload: unknown = payload;
    if (existing) {
      const reclaimed = await reclaimStaleInFlightCommand(c.env, user.id, existing.id);
      if (!reclaimed) {
        const current = await findCommandByIdempotencyKey(c.env, user.id, idempotencyKey);
        if (current) return c.json({ command: current, replayed: true }, 200);
        return c.json({ error: 'a duplicate command is already in flight; retry shortly' }, 409);
      }
      command = reclaimed;
      executionType = command.type;
      executionPayload = command.payload;
    } else {
      try {
        command = await createCommand(c.env, { userId: user.id, type, payload, idempotencyKey });
      } catch (err) {
        // True concurrent-duplicate race: our lookup above saw nothing, but a
        // peer request's INSERT for the same (user, idempotencyKey) committed
        // first and won the unique-index race. Replay its row (or 409 if it
        // vanished between the failed insert and this re-fetch) instead of
        // letting the raw D1 constraint violation surface as a 500.
        if (err instanceof DuplicateCommandError && idempotencyKey) {
          const won = await findCommandByIdempotencyKey(c.env, user.id, idempotencyKey);
          if (won) return c.json({ command: won, replayed: true }, 200);
          return c.json({ error: 'a duplicate command is already in flight; retry shortly' }, 409);
        }
        throw err;
      }
      command = await updateCommandStatus(c.env, user.id, command.id, 'running');
    }

    try {
      const result = await executeCommand(c.env, user, executionType, executionPayload, { commandId: command.id });
      const done = await updateCommandStatus(c.env, user.id, command.id, 'succeeded', {
        result: persistedCommandResult(executionType, result),
      });
      return c.json({ command: done, result }, 201);
    } catch (err) {
      const e = err as ClientInputError;
      const failed = await updateCommandStatus(c.env, user.id, command.id, 'failed', { error: e.message });
      return c.json({ command: failed, error: e.message }, errorStatus(e));
    }
  });

  return r;
}
