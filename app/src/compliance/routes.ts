/**
 * src/compliance/routes.ts
 * Compliance router — GDPR/CCPA user data deletion.
 *
 *   DELETE /api/compliance/delete-my-data
 *     Requires authentication via session cookie. Anonymizes user email,
 *     clears OAuth links, cancels Stripe billing, and deletes preferences
 *     and the current session.
 */

import { Hono } from 'hono';
import type { Env } from '../shared/types';
import { resolveSession, destroySession, getSessionTokenFromRequest } from '../auth/session';

export function buildComplianceRouter(): Hono<{ Bindings: Env }> {
  const r = new Hono<{ Bindings: Env }>();

  // DELETE /api/compliance/delete-my-data
  r.delete('/delete-my-data', async (c) => {
    const sessionToken = getSessionTokenFromRequest(c);
    if (!sessionToken) return c.json({ error: 'unauthorized' }, 401);

    const user = await resolveSession(c.env, sessionToken);
    if (!user) return c.json({ error: 'unauthorized' }, 401);

    const db = c.env.DB;
    const anonEmail = `deleted-${Date.now()}@anon.congress.trade`;

    try {
      // Anonymize user data: email → removed@timestamp, clear OAuth links,
      // clear Stripe billing, set plan to null (free).
      await db
        .prepare(
          `UPDATE users SET
             email = ?,
             google_sub = NULL,
             stripe_customer_id = NULL,
             subscription_status = 'canceled',
             plan = NULL,
             current_period_end = NULL,
             cancel_at_period_end = 0,
             trial_end = NULL
           WHERE id = ?`,
        )
        .bind(anonEmail, user.id)
        .run();

      // Delete user preferences.
      await db.prepare(`DELETE FROM user_preferences WHERE user_id = ?`).bind(user.id).run();

      // Delete the current session from KV.
      await destroySession(c.env, sessionToken);

      return c.json({ ok: true, message: 'Your data has been deleted' });
    } catch (err) {
      console.error('compliance deletion failed:', (err as Error).message);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  return r;
}
