CREATE TABLE IF NOT EXISTS deno_runtime_kv (
    namespace TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    expires_at INTEGER,
    PRIMARY KEY (namespace, key)
);
