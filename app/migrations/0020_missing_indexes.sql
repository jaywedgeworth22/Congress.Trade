-- 0020_missing_indexes.sql
-- Additional performance indexes on the transactions table.
-- Note: idx_tx_ticker and idx_tx_filer already exist from 0001_init.sql as
-- single-column indexes covering the same columns. These new indexes
-- use the longer naming convention to match the rest of the application.
-- idx_tx_date and idx_tx_cursor (covering tx_date / cursor_seq) already
-- exist from 0001_init.sql and are not duplicated here.
CREATE INDEX IF NOT EXISTS idx_transactions_ticker ON transactions(ticker);
CREATE INDEX IF NOT EXISTS idx_transactions_filer_id ON transactions(filer_id);
