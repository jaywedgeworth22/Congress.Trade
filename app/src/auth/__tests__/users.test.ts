import { describe, it, expect } from 'vitest';
import { upsertUserFromGoogle, upsertUserByEmail } from '../users';
import type { Env } from '../../shared/types';

interface Row {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
  google_sub: string | null;
  email_verified: number;
  created_at: string;
  last_login_at: string | null;
}

// Stateful in-memory `users` table supporting exactly the queries users.ts issues.
function fakeEnv() {
  const byId = new Map<string, Row>();
  const byEmail = new Map<string, string>(); // email -> id

  const prepare = (sql: string) => ({
    _p: [] as unknown[],
    bind(...p: unknown[]) {
      this._p = p;
      return this;
    },
    async first<T>() {
      if (/FROM users WHERE id/i.test(sql)) {
        return (byId.get(this._p[0] as string) ?? null) as T | null;
      }
      if (/FROM users WHERE email/i.test(sql)) {
        const id = byEmail.get((this._p[0] as string).toLowerCase());
        return ((id && byId.get(id)) ?? null) as T | null;
      }
      return null as T | null;
    },
    async run() {
      const p = this._p as unknown[];
      if (/INSERT INTO users/i.test(sql)) {
        // Two shapes: google path binds 8 params; the magic-link path uses SQL
        // literals (NULL, NULL, NULL, 1) and binds only [id, email, created, last].
        let row: Row;
        if (p.length === 8) {
          const [id, email, name, picture, google_sub, email_verified, created_at, last_login_at] = p as [
            string, string, string | null, string | null, string | null, number, string, string | null,
          ];
          row = {
            id,
            email,
            name: name ?? null,
            picture: picture ?? null,
            google_sub: google_sub ?? null,
            email_verified: Number(email_verified),
            created_at,
            last_login_at: last_login_at ?? null,
          };
        } else {
          const [id, email, created_at, last_login_at] = p as [string, string, string, string | null];
          row = {
            id,
            email,
            name: null,
            picture: null,
            google_sub: null,
            email_verified: 1,
            created_at,
            last_login_at: last_login_at ?? null,
          };
        }
        byId.set(row.id, row);
        byEmail.set(row.email, row.id);
      } else if (/UPDATE users\s+SET\s+name/i.test(sql)) {
        // google path: name, picture, google_sub, email_verified, last_login_at, id
        const [name, picture, google_sub, email_verified, last_login_at, id] = p as [
          string | null, string | null, string | null, number, string, string,
        ];
        const r = byId.get(id);
        if (r) {
          if (name != null) r.name = name;
          if (picture != null) r.picture = picture;
          r.google_sub = google_sub ?? null;
          r.email_verified = Number(email_verified);
          r.last_login_at = last_login_at;
        }
      } else if (/UPDATE users SET email_verified/i.test(sql)) {
        const [last_login_at, id] = p as [string, string];
        const r = byId.get(id);
        if (r) {
          r.email_verified = 1;
          r.last_login_at = last_login_at;
        }
      }
      return { success: true } as unknown;
    },
    async all<T>() {
      return { results: [] as T[] };
    },
  });

  const env = { DB: { prepare } as unknown as D1Database } as unknown as Env;
  return { env, byId };
}

describe('upsertUserFromGoogle', () => {
  it('creates a new user, then updates the same record on the second call', async () => {
    const { env } = fakeEnv();
    const u1 = await upsertUserFromGoogle(env, {
      sub: 'g1',
      email: 'Jay@X.com',
      emailVerified: true,
      name: 'Jay',
      picture: 'p1',
    });
    expect(u1.email).toBe('jay@x.com'); // lowercased
    expect(u1.googleSub).toBe('g1');
    expect(u1.emailVerified).toBe(true);

    const u2 = await upsertUserFromGoogle(env, {
      sub: 'g1',
      email: 'jay@x.com',
      emailVerified: true,
      name: 'Jay R',
      picture: 'p2',
    });
    expect(u2.id).toBe(u1.id); // keyed by email -> same user
    expect(u2.name).toBe('Jay R');
    expect(u2.picture).toBe('p2');
  });

  it('refuses to match or create an account from an unverified Google email', async () => {
    const { env, byId } = fakeEnv();
    // Seed a victim account owned via the (verified) magic-link path.
    const victim = await upsertUserByEmail(env, 'victim@x.com');

    // An attacker's Google profile claims the victim's address without
    // email_verified: the upsert must throw and mutate nothing.
    await expect(
      upsertUserFromGoogle(env, {
        sub: 'attacker-sub',
        email: 'victim@x.com',
        emailVerified: false,
        name: 'Attacker',
        picture: null,
      }),
    ).rejects.toThrow(/not verified/);
    const untouched = byId.get(victim.id)!;
    expect(untouched.google_sub).toBeNull();
    expect(untouched.name).toBeNull();

    // And it must not create new accounts from unverified emails either.
    await expect(
      upsertUserFromGoogle(env, {
        sub: 'attacker-sub',
        email: 'new-unverified@x.com',
        emailVerified: false,
      }),
    ).rejects.toThrow(/not verified/);
    expect(byId.size).toBe(1);
  });
});

describe('upsertUserByEmail (magic-link)', () => {
  it('creates a verified, google-less user and is idempotent', async () => {
    const { env } = fakeEnv();
    const u1 = await upsertUserByEmail(env, 'New@User.com');
    expect(u1.email).toBe('new@user.com');
    expect(u1.emailVerified).toBe(true);
    expect(u1.googleSub).toBeNull();

    const u2 = await upsertUserByEmail(env, 'new@user.com');
    expect(u2.id).toBe(u1.id);
  });
});
