/**
 * src/auth/magic.ts
 * Passwordless email magic-link tokens. Only the SHA-256 *hash* of a token is
 * stored (in CONFIG_KV under `magic:<hash>`), with a 15-minute TTL and
 * single-use semantics (consumed = deleted).
 */

import type { Env } from '../shared/types.ts';
import { randomToken, sha256Hex } from './tokens.ts';

const MAGIC_PREFIX = 'magic:';
const MAGIC_TTL_SEC = 15 * 60; // 15 minutes

/** Issue a magic-link token for `email`; stores its hash, returns the raw token. */
export async function issueMagicToken(env: Env, email: string): Promise<string> {
  const token = randomToken(32);
  const key = MAGIC_PREFIX + (await sha256Hex(token));
  await env.CONFIG_KV.put(key, email.toLowerCase(), { expirationTtl: MAGIC_TTL_SEC });
  return token;
}

/** Consume a magic-link token: returns the email if valid+unused, else null. */
export async function consumeMagicToken(env: Env, token: string): Promise<string | null> {
  const key = MAGIC_PREFIX + (await sha256Hex(token));
  const email = await env.CONFIG_KV.get(key);
  if (!email) return null;
  await env.CONFIG_KV.delete(key); // single use
  return email;
}

/** Render the sign-in email body for a verify URL. */
export function magicLinkEmail(verifyUrl: string): { subject: string; html: string; text: string } {
  const subject = 'Your Congress.Trade sign-in link';
  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto">
    <h2 style="margin:0 0 12px">Sign in to Congress.Trade</h2>
    <p style="color:#333">Click the button below to sign in. This link expires in 15 minutes and can be used once.</p>
    <p><a href="${verifyUrl}" style="display:inline-block;background:#1a73e8;color:#fff;padding:11px 20px;border-radius:6px;text-decoration:none;font-weight:600">Sign in</a></p>
    <p style="color:#666;font-size:13px;word-break:break-all">Or paste this URL into your browser:<br>${verifyUrl}</p>
    <p style="color:#999;font-size:12px">If you didn't request this, you can safely ignore this email.</p>
  </div>`;
  const text = `Sign in to Congress.Trade:\n${verifyUrl}\n\nThis link expires in 15 minutes and can be used once. If you didn't request it, ignore this email.`;
  return { subject, html, text };
}
