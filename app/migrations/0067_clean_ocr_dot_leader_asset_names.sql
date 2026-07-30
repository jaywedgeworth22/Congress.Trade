-- 0067_clean_ocr_dot_leader_asset_names.sql
-- Clean up OCR dot leaders and junk placeholder strings stored in transactions.asset_name,
-- and populate proper company names for known ticker symbols from securities_ref.
-- Records a durable audit/cleaning note on every modified transaction row.
-- Mirrored idempotently in POST /api/admin/migrate (src/admin/migrations.ts).

ALTER TABLE transactions ADD COLUMN cleaning_note TEXT;

UPDATE transactions
   SET cleaning_note = 'Cleaned OCR dot leader noise (Original: ' || asset_name || ')',
       asset_name = NULL
 WHERE asset_name IN (
    '..', '...', '....', '.....', '......', '.......', '........', '.........', '..........',
    '...........', '............', '.............', '..............', '...............',
    '................', '.................', '..................', '...................',
    '....................', '.....................', '......................',
    '.......................', '........................', '.........................',
    '..........................', '...........................', '............................',
    '................ me', '.............................', '..............................',
    '.....]', '......s', '..........A', '..o', '...................0', '...................e', '.............e'
 );

UPDATE transactions
   SET cleaning_note = 'Stripped OCR dot leader suffix (Original: ' || asset_name || ')',
       asset_name = 'ARCC'
 WHERE asset_name LIKE 'ARCC .%';

UPDATE transactions
   SET cleaning_note = 'Stripped OCR dot leader suffix (Original: ' || asset_name || ')',
       asset_name = 'NVDA'
 WHERE asset_name LIKE 'NVDA .%';

UPDATE transactions
   SET cleaning_note = 'Stripped OCR dot leader suffix (Original: ' || asset_name || ')',
       asset_name = 'XOM'
 WHERE asset_name LIKE 'XOM .%';

UPDATE transactions
   SET cleaning_note = 'Stripped OCR dot leader suffix (Original: ' || asset_name || ')',
       asset_name = 'BAC'
 WHERE asset_name LIKE 'BAC .%';

UPDATE transactions
   SET cleaning_note = 'Stripped OCR dot leader suffix (Original: ' || asset_name || ')',
       asset_name = 'FMAO'
 WHERE asset_name LIKE 'FMAO .%';

UPDATE transactions
   SET cleaning_note = 'Stripped OCR dot leader suffix (Original: ' || asset_name || ')',
       asset_name = 'HD'
 WHERE asset_name LIKE 'HD .%';

UPDATE transactions
   SET cleaning_note = 'Cleaned junk OCR text (Original: ' || asset_name || ')',
       asset_name = NULL
 WHERE (asset_name LIKE '...%' OR asset_name LIKE '%...' OR asset_name LIKE '%....%')
   AND cleaning_note IS NULL;

-- Populate proper company names from securities_ref when ticker is known and asset_name is missing/junk/ticker-only
UPDATE transactions
   SET cleaning_note = COALESCE(cleaning_note, 'Populated official company name from securities_ref for ticker: ' || ticker),
       asset_name = (
         SELECT s.company_name
           FROM securities_ref s
          WHERE UPPER(s.ticker) = UPPER(transactions.ticker)
            AND s.company_name IS NOT NULL
            AND s.company_name <> ''
          LIMIT 1
       )
 WHERE transactions.ticker IS NOT NULL
   AND (
         transactions.asset_name IS NULL
      OR transactions.asset_name = ''
      OR transactions.asset_name = '(unknown)'
      OR UPPER(transactions.asset_name) = UPPER(transactions.ticker)
   )
   AND EXISTS (
         SELECT 1
           FROM securities_ref s
          WHERE UPPER(s.ticker) = UPPER(transactions.ticker)
            AND s.company_name IS NOT NULL
            AND s.company_name <> ''
   );
