-- 0096_latency_confidence_relabel.sql
-- Relabel snapshot confidence descriptors to better match data provenance:
-- 'exact' for internal ct_publish becomes 'system'
-- 'bracketed' (within probe window) becomes 'observed'
-- 'exact' for competitor timestamps becomes 'claimed'

UPDATE latency_price_snapshots SET confidence = 'system' WHERE event = 'ct_publish';
UPDATE latency_price_snapshots SET confidence = 'observed' WHERE confidence = 'bracketed';
UPDATE latency_price_snapshots SET confidence = 'claimed' WHERE confidence = 'exact' AND event != 'ct_publish';
