-- 0003_users.sql
-- End-user accounts for the public site (Google OAuth + email magic-link login).
-- Distinct from the admin surface (Cloudflare Access / ADMIN_TOKEN) and from the
-- delivery `subscriptions` table (webhook/SSE targets, not billing). Stripe /
-- billing columns are added in a later migration.

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  name           TEXT,
  picture        TEXT,
  google_sub     TEXT UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  last_login_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
