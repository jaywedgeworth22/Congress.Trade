-- 0067_clean_ocr_dot_leader_asset_names.sql
-- Clean up OCR dot leaders and junk placeholder strings stored in transactions.asset_name.
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
    '.............................', '..............................',
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
