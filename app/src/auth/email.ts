/**
 * src/auth/email.ts
 * Transactional email via Resend (simple REST API, works on Workers). Swapping
 * providers is a one-module change. Requires RESEND_API_KEY + EMAIL_FROM.
 */

import type { Env } from '../shared/types';

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

/** Send a transactional email. Throws if not configured or on API error. */
export async function sendEmail(env: Env, msg: EmailMessage): Promise<void> {
  if (!emailConfigured(env)) {
    throw new Error('email not configured (set RESEND_API_KEY + EMAIL_FROM)');
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`email send failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
}
