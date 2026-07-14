/**
 * src/auth/email.ts
 * Transactional email via Resend (simple REST API, works on Workers). Swapping
 * providers is a one-module change. Requires RESEND_API_KEY + EMAIL_FROM.
 */

import type { Env } from '../shared/types';
import { resolveSecrets } from '../secrets/infisical';
import { trackedFetch } from '../shared/thirdPartyTelemetry';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

/** True when an email provider is configured (so callers can degrade gracefully). */
export function emailConfigured(env: Env): boolean {
  return !!(env.RESEND_API_KEY && env.EMAIL_FROM);
}

export async function emailConfiguredAsync(env: Env): Promise<boolean> {
  const s = await resolveSecrets(env, ['RESEND_API_KEY', 'EMAIL_FROM']);
  return Boolean(s.RESEND_API_KEY && s.EMAIL_FROM);
}

/** Send a transactional email. Throws if not configured or on API error. */
export async function sendEmail(env: Env, msg: EmailMessage): Promise<void> {
  const s = await resolveSecrets(env, ['RESEND_API_KEY', 'EMAIL_FROM']);
  if (!s.RESEND_API_KEY || !s.EMAIL_FROM) {
    throw new Error('email not configured (set RESEND_API_KEY + EMAIL_FROM)');
  }
  const res = await trackedFetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${s.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: s.EMAIL_FROM,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
    }),
  }, { service: 'email', operation: 'send-transactional-email' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`email send failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
}
