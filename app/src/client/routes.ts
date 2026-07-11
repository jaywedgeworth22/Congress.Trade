/**
 * src/client/routes.ts
 *
 * Shared backend-owned API for the phone-first PWA and SwiftUI app.
 * Mounted at /api/client/v1. Public reads stay public; preferences and commands
 * require the existing opaque session via cookie or Authorization bearer.
 */

import { Hono } from 'hono';
import type { Env, User, ClientCommandType } from '../shared/types';

import { getCurrentUserFromRequest } from '../auth/session';
import { entitlementOf } from '../billing/entitlement';
import { normalizeTickerLogoSymbol } from '../ui/tickerLogos';
import {
  createCommand,
  findCommandByIdempotencyKey,
  getCommand,
  getPreferences,
  listCommands,
  updateCommandStatus,
  upsertPreferences,
} from './state';
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
} from './utils';
import {
  getClientTrade,
  getSecurityRef,
  listUserSubscriptions,
  memberSummarySql,
  readClientTradeList,
  resolveMember,
  tickerSummarySql,
} from './queries';
import { commandType, executeCommand, normalizePreferencePatch, persistedCommandResult } from './commands';
import { get } from '../shared/db';
import type { TradeSummaryRow } from './types';

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
    return c.json({ ...(await readClientTradeList(c.env, params as any)), nextPollAfterSec: 30 });
  });

  r.get('/trade/:id', async (c) => {
    const id = (c.req.param('id') || '').trim();
    if (!id || id.length > 128) return c.json({ error: 'invalid trade id' }, 400);
    const item = await getClientTrade(c.env, id);
    if (!item) return c.json({ error: 'trade not found' }, 404);
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
    const params: any = {
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
    const resolved = await resolveMember(c.env, memberIdOrName);
    if (!resolved) return c.json({ error: 'member not found' }, 404);
    const params: any = {
      member: resolved.id,
      limit: detailLimit(c.req.query('limit')),
      order: asOrder(c.req.query('order')) ?? 'desc',
    };
    const summaryQ = memberSummarySql(resolved.id);
    const [list, summaryRow] = await Promise.all([
      readClientTradeList(c.env, params),
      get<TradeSummaryRow>(c.env.DB, summaryQ.sql, summaryQ.params),
    ]);
    if (!resolved.profile && list.total === 0) return c.json({ error: 'member not found' }, 404);
    return c.json({
      member: memberProfile(resolved.profile, resolved.id),
      summary: {
        ...baseSummary(summaryRow),
        uniqueTickers: num(summaryRow?.unique_tickers),
        uniqueAssets: num(summaryRow?.unique_assets),
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
    const replay = await findCommandByIdempotencyKey(c.env, user.id, idempotencyKey);
    if (replay) return c.json({ command: replay, replayed: true }, 200);

    const command = await createCommand(c.env, { userId: user.id, type, payload, idempotencyKey });
    await updateCommandStatus(c.env, user.id, command.id, 'running');
    try {
      const result = await executeCommand(c.env, user, type, payload);
      const done = await updateCommandStatus(c.env, user.id, command.id, 'succeeded', {
        result: persistedCommandResult(type, result),
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
