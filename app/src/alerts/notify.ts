/**
 * src/alerts/notify.ts
 * Admin email alerts (operational notifications), sent via the same Resend
 * transport used for magic-link login. Delivery is best-effort and throttled by
 * a KV stamp so a recurring condition can't spam the inbox. Requires:
 *   - ALERT_EMAIL                       (recipient)
 *   - RESEND_API_KEY + EMAIL_FROM       (the Wave 4 email setup; sender)
 * If any are unset, notify() is a logged no-op (callers don't need to care).
 */

import type { Env } from '../shared/types';
import { sendEmail, emailConfiguredAsync } from '../auth/email';
import { resolveSecret } from '../secrets/infisical';

type EnvAlert = Env & { ALERT_EMAIL?: string };

export interface AlertResult {
  sent: boolean;
  /** Why it didn't send (unset recipient, unconfigured email, throttled, error). */
  reason?: string;
}

const DEFAULT_THROTTLE_SEC = 12 * 60 * 60; // 12h between alerts of the same kind

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string,
  );
}

/**
 * Send an operational alert email to ALERT_EMAIL, deduped by `dedupeKey` for
 * `throttleSec` (so the same condition emails at most once per window).
 */
export async function notifyAdmin(
  env: Env,
  opts: { subject: string; text: string; dedupeKey: string; throttleSec?: number },
): Promise<AlertResult> {
  const to = ((await resolveSecret(env, 'ALERT_EMAIL')).value ?? (env as EnvAlert).ALERT_EMAIL)?.trim();
  if (!to) return { sent: false, reason: 'ALERT_EMAIL not set' };
  if (!(await emailConfiguredAsync(env))) return { sent: false, reason: 'email not configured (RESEND_API_KEY/EMAIL_FROM)' };

  const throttleKey = 'alert:' + opts.dedupeKey;
  try {
    if (await env.CONFIG_KV.get(throttleKey)) return { sent: false, reason: 'throttled' };
  } catch {
    /* KV read failure: fall through and try to send rather than go silent */
  }

  try {
    await sendEmail(env, {
      to,
      subject: opts.subject,
      text: opts.text,
      html: `<pre style="font-family:ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap">${escapeHtml(
        opts.text,
      )}</pre>`,
    });
  } catch (err) {
    return { sent: false, reason: (err as Error).message };
  }

  try {
    await env.CONFIG_KV.put(throttleKey, new Date().toISOString(), {
      expirationTtl: opts.throttleSec ?? DEFAULT_THROTTLE_SEC,
    });
  } catch {
    /* best-effort throttle stamp */
  }
  return { sent: true };
}
