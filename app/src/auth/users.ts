/**
 * src/auth/users.ts
 * End-user records in D1 (`users` table). Distinct from the admin surface and
 * from delivery `subscriptions` (which are webhook/SSE targets, not billing).
 * Stripe/billing columns are layered on in a later migration; this module owns
 * identity only.
 */

import type { Env, User } from '../shared/types';
import { get, run } from '../shared/db';
import { uuid } from '../shared/ids';

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
  google_sub: string | null;
  email_verified: number;
  created_at: string;
  last_login_at: string | null;
  // Billing columns (migration 0004). Absent on rows read before the migration
  // is applied, hence the `?`-guarded coercions in mapUser.
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
  subscription_status?: string | null;
  plan?: string | null;
  current_period_end?: string | null;
  cancel_at_period_end?: number | null;
  trial_end?: string | null;
}

function mapUser(r: UserRow): User {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    picture: r.picture,
    googleSub: r.google_sub,
    emailVerified: r.email_verified === 1,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
    stripeCustomerId: r.stripe_customer_id ?? null,
    stripeSubscriptionId: r.stripe_subscription_id ?? null,
    subscriptionStatus: r.subscription_status ?? null,
    plan: (r.plan as User['plan']) ?? null,
    currentPeriodEnd: r.current_period_end ?? null,
    cancelAtPeriodEnd: r.cancel_at_period_end === 1,
    trialEnd: r.trial_end ?? null,
  };
}

export async function getUserById(env: Env, id: string): Promise<User | null> {
  const r = await get<UserRow>(env.DB, 'SELECT * FROM users WHERE id = ?', [id]);
  return r ? mapUser(r) : null;
}

export async function getUserByEmail(env: Env, email: string): Promise<User | null> {
  const r = await get<UserRow>(env.DB, 'SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
  return r ? mapUser(r) : null;
}

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string | null;
  picture?: string | null;
}

/**
 * Upsert a user from a verified Google profile, keyed by email.
 *
 * SECURITY: Google only attests ownership of an email when email_verified is
 * true. Matching-or-creating by an UNVERIFIED email would let an attacker who
 * registers a Google account claiming a victim's address take over the
 * victim's existing (e.g. magic-link) account. Callers should check
 * `emailVerified` first for a friendly error; this throw is the backstop.
 */
export async function upsertUserFromGoogle(env: Env, p: GoogleProfile): Promise<User> {
  if (p.emailVerified !== true) {
    throw new Error('google profile email is not verified; refusing to match or create an account');
  }
  const email = p.email.toLowerCase();
  const now = new Date().toISOString();
  const existing = await getUserByEmail(env, email);
  if (existing) {
    await run(
      env.DB,
      `UPDATE users
          SET name = COALESCE(?, name),
              picture = COALESCE(?, picture),
              google_sub = ?,
              email_verified = ?,
              last_login_at = ?
        WHERE id = ?`,
      [p.name ?? null, p.picture ?? null, p.sub, p.emailVerified ? 1 : 0, now, existing.id],
    );
    return (await getUserById(env, existing.id)) as User;
  }
  const id = uuid();
  await run(
    env.DB,
    `INSERT INTO users (id, email, name, picture, google_sub, email_verified, created_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, email, p.name ?? null, p.picture ?? null, p.sub, p.emailVerified ? 1 : 0, now, now],
  );
  return (await getUserById(env, id)) as User;
}

/** Upsert a user identified by a (just-verified) email — the magic-link path. */
export async function upsertUserByEmail(env: Env, emailRaw: string): Promise<User> {
  const email = emailRaw.toLowerCase();
  const now = new Date().toISOString();
  const existing = await getUserByEmail(env, email);
  if (existing) {
    await run(env.DB, 'UPDATE users SET email_verified = 1, last_login_at = ? WHERE id = ?', [
      now,
      existing.id,
    ]);
    return (await getUserById(env, existing.id)) as User;
  }
  const id = uuid();
  await run(
    env.DB,
    `INSERT INTO users (id, email, name, picture, google_sub, email_verified, created_at, last_login_at)
     VALUES (?, ?, NULL, NULL, NULL, 1, ?, ?)`,
    [id, email, now, now],
  );
  return (await getUserById(env, id)) as User;
}
