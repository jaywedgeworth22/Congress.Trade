-- 0031_agreement_cascade.sql
-- Durable eligibility, retry, and lease state for the autonomous agreement
-- cascade. `agreement_attempted_at` is retained as a last-attempt audit stamp;
-- eligibility is driven by attempts, next_attempt_at, and the expiring claim.
-- Reopen paths reset this state while preserving agreement_legacy_replay_at.
-- Mirrored idempotently in POST /api/admin/migrate (src/admin/routes.ts).

ALTER TABLE review_queue ADD COLUMN agreement_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE review_queue ADD COLUMN agreement_tier INTEGER;
ALTER TABLE review_queue ADD COLUMN agreement_next_attempt_at TEXT;
ALTER TABLE review_queue ADD COLUMN agreement_claim_token TEXT;
ALTER TABLE review_queue ADD COLUMN agreement_claimed_at TEXT;
ALTER TABLE review_queue ADD COLUMN agreement_legacy_replay_at TEXT;

CREATE INDEX IF NOT EXISTS idx_review_queue_agreement_eligible
  ON review_queue (resolved, agreement_next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_review_queue_agreement_claim
  ON review_queue (agreement_claim_token, agreement_claimed_at);

-- If a review was genuinely reopened during the deploy-before-migrate window,
-- created_at is newer than its old attempt stamp. Make that row eligible. This
-- predicate self-invalidates when the attempt stamp is cleared, so rerunning
-- the idempotent admin migration is safe and is not a blanket reset.
UPDATE review_queue
   SET agreement_attempted_at = NULL,
       agreement_attempts = 0,
       agreement_tier = NULL,
       agreement_next_attempt_at = NULL,
       agreement_claim_token = NULL,
       agreement_claimed_at = NULL
 WHERE resolved = 0
   AND agreement_attempted_at IS NOT NULL
   AND created_at > agreement_attempted_at;

-- gpt-4o-mini was the configured model B from 2026-06-26 through 2026-07-10
-- and rejected the PDF payload shape. Re-eligibilize that unresolved cohort
-- exactly once. The fixed cutoff prevents later healthy attempts from being
-- replayed; the durable marker prevents this idempotent statement from
-- resetting the cohort again on every POST /api/admin/migrate call. Resolved
-- source-verified rows are deliberately excluded.
UPDATE review_queue
   SET agreement_attempted_at = NULL,
       agreement_attempts = 0,
       agreement_tier = NULL,
       agreement_next_attempt_at = NULL,
       agreement_claim_token = NULL,
       agreement_claimed_at = NULL,
       agreement_legacy_replay_at = CURRENT_TIMESTAMP
 WHERE resolved = 0
   AND agreement_legacy_replay_at IS NULL
   AND agreement_attempted_at >= '2026-06-26T00:00:00.000Z'
   AND agreement_attempted_at < '2026-07-11T00:00:00.000Z';
