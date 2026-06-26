-- 0017_fb_meta_remap.sql
-- Facebook's old "FB" ticker was reassigned by the SEC to a ProShares ETF after
-- Meta Platforms moved to "META", so congressional trades filed under "FB" were
-- resolving to the ProShares name. Remap stored FB rows to META and correct the
-- cached company names. Idempotent (plain UPDATEs); also mirrored in the
-- POST /api/admin/migrate statement list in src/admin/routes.ts.

UPDATE transactions
   SET ticker = 'META'
 WHERE ticker = 'FB' AND deprecated_at IS NULL;

UPDATE securities_ref
   SET company_name = 'Meta Platforms, Inc.'
 WHERE ticker = 'META'
   AND (company_name IS NULL OR company_name = '' OR company_name LIKE '%ProShares%');

UPDATE securities_master
   SET name = 'Meta Platforms, Inc.'
 WHERE ticker = 'META';
