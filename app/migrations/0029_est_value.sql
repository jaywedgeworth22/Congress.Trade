-- 0029_est_value.sql
-- Materialized computed column for estimated transaction value.

ALTER TABLE transactions ADD COLUMN est_value REAL;

UPDATE transactions SET est_value = CASE
  WHEN amount_min IS NULL AND amount_max IS NULL THEN 0
  WHEN amount_min IS NULL THEN amount_max
  WHEN amount_max IS NULL THEN amount_min
  ELSE (amount_min + amount_max) / 2.0
END WHERE est_value IS NULL;
