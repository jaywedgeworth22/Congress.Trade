-- 0069_client_command_secret_claim.sql
-- One-time disclosure for command-issued delivery credentials.
-- The create_subscription secret no longer lives in client_commands.result
-- (which GET /commands, GET /commands/:id and idempotency replay all return
-- verbatim); it moves to result_secret, which the first owner-authenticated
-- GET /commands/:id claims and nulls in a single atomic UPDATE.
ALTER TABLE client_commands ADD COLUMN result_secret TEXT;
ALTER TABLE client_commands ADD COLUMN result_claimed_at TEXT;

-- Backfill: scrub secrets already persisted into result by the async-command
-- path (commit ffc09af0). Idempotent — after the first run json_extract()
-- returns NULL so the predicate stops matching.
UPDATE client_commands
   SET result = json_remove(result, '$.subscription.secret', '$.subscription.streamUrl'),
       result_claimed_at = COALESCE(result_claimed_at, updated_at)
 WHERE type = 'create_subscription'
   AND result IS NOT NULL
   AND json_valid(result)
   AND json_extract(result, '$.subscription.secret') IS NOT NULL;
