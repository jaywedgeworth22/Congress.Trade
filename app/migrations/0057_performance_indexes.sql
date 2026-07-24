-- 0047_performance_indexes.sql
-- Add indexes to fix massive read spikes for keyset pagination and feed queries

CREATE INDEX IF NOT EXISTS idx_price_eod_ticker_date_asc ON price_eod (ticker ASC, date ASC);
CREATE INDEX IF NOT EXISTS idx_transactions_date_cursor_desc ON transactions (tx_date DESC, cursor_seq DESC) WHERE deprecated_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_cursor_asc ON transactions (cursor_seq ASC) WHERE deprecated_at IS NULL;
