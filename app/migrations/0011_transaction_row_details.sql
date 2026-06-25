-- 0011_transaction_row_details.sql
-- Preserve structured House PTR row details that are specific to the filer,
-- filing, or row, while keeping the original row text for audit/review.

ALTER TABLE transactions ADD COLUMN asset_type_name TEXT;
ALTER TABLE transactions ADD COLUMN filing_status TEXT;
ALTER TABLE transactions ADD COLUMN subholding TEXT;
ALTER TABLE transactions ADD COLUMN location TEXT;
ALTER TABLE transactions ADD COLUMN description TEXT;
ALTER TABLE transactions ADD COLUMN supplemental_text TEXT;

CREATE INDEX IF NOT EXISTS idx_tx_asset_type_name ON transactions (asset_type_name);
