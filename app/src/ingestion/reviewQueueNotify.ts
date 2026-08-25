/**
 * src/ingestion/reviewQueueNotify.ts
 *
 * Wake Grok Bot Publisher when a doc enters human review (new review_queue row
 * or a resolved row flipped back to pending).  Fail-closed: both
 * REVIEW_QUEUE_PUBLISHER_WEBHOOK_URL and REVIEW_QUEUE_PUBLISHER_WEBHOOK_SECRET
 * must be configured; the target URL is SSRF-checked before every POST.
 *
 * FAIL-SOFT BY CONTRACT: callers invoke this after the review transition has
 * committed.  A missing config, DNS failure, or HTTP error is logged and
 * swallowed — never surfaced to the extraction/admin path.
 */

import type { Env } from '../shared/types.ts';
import { resolveSecret } from '../secrets/infisical.ts';
import { validatePublicWebhookTarget } from '../delivery/webhookTarget.ts';
import { signWebhookPayloadV1 } from '../delivery/webhook.ts';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';

export interface ReviewQueueNotifyInput {
  docId: string;
  reason?: string | null;
  /** ISO timestamp for the transition; defaults to now. */
  at?: string;
  /** Distinguish a fresh insert from a reopen (resolved → pending). */
  kind?: 'insert' | 'reopen';
}

interface ReviewQueuePublisherConfig {
  url: string;
  secret: string;
}

async function loadPublisherConfig(env: Env): Promise<ReviewQueuePublisherConfig | null> {
  const [urlRes, secretRes] = await Promise.all([
    resolveSecret(env, 'REVIEW_QUEUE_PUBLISHER_WEBHOOK_URL'),
    resolveSecret(env, 'REVIEW_QUEUE_PUBLISHER_WEBHOOK_SECRET'),
  ]);
  const url = urlRes.value?.trim();
  const secret = secretRes.value?.trim();
  if (!url || !secret) return null;
  return { url, secret };
}

/**
 * POST a small signed webhook so the publisher can wake immediately.
 * No-op when URL/secret are unset or the target fails SSRF validation.
 */
export async function notifyReviewQueuePublisher(
  env: Env,
  input: ReviewQueueNotifyInput,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const docId = input.docId?.trim();
  if (!docId) return;

  try {
    const cfg = await loadPublisherConfig(env);
    if (!cfg) return;

    const allowLocalhost = env.USAGE_MONITOR_ENVIRONMENT?.toLowerCase() === 'local'
      || env.ADMIN_OPEN_IN_DEV === 'true';
    const targetError = await validatePublicWebhookTarget(cfg.url, {
      allowLocalhost,
      fetchImpl: deps.fetchImpl,
    });
    if (targetError) {
      console.warn('review_queue notify: blocked target —', targetError);
      return;
    }

    const at = input.at ?? new Date().toISOString();
    const body = JSON.stringify({
      event: 'review_queue.entered',
      docId,
      reason: input.reason ?? null,
      kind: input.kind ?? 'insert',
      at,
    });
    const signedAtSec = Math.floor(Date.parse(at) / 1000) || Math.floor(Date.now() / 1000);
    const signature = await signWebhookPayloadV1(env, signedAtSec, body, cfg.secret);
    const fetchImpl = deps.fetchImpl ?? fetch;

    const response = await trackedFetch(
      cfg.url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-ct-signature': `t=${signedAtSec},v1=${signature}`,
        },
        body,
      },
      { service: 'review-queue-notify', operation: 'publisher-webhook' },
      fetchImpl,
    );
    if (!response.ok) {
      console.warn(
        `review_queue notify: publisher returned HTTP ${response.status} for ${docId}`,
      );
    }
  } catch (err) {
    console.warn('review_queue notify failed:', docId, (err as Error).message);
  }
}
