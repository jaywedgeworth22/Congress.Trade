-- 0070_purge_leaked_kv_credentials.sql
-- Purge leaked session and magic tokens incorrectly mirrored to deno_runtime_kv table in primary DB.
DELETE FROM deno_runtime_kv WHERE namespace = 'config' AND (key LIKE 'sess:%' OR key LIKE 'magic:%');
