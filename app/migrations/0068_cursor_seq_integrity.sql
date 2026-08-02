-- Sequence-authoritative cursor: no writer may supply cursor_seq. The old
-- `WHEN NEW.cursor_seq IS NULL` guard let app/scripts/backfill_holes.ts write
-- Date.now() epochs, which permanently outranked the real sequence.
DROP TRIGGER IF EXISTS trg_transactions_cursor;
CREATE TRIGGER trg_transactions_cursor
AFTER INSERT ON transactions
FOR EACH ROW
BEGIN
  INSERT INTO tx_cursor_seq (tx_id) VALUES (NEW.id);
  UPDATE transactions
     SET cursor_seq = (SELECT MAX(seq) FROM tx_cursor_seq WHERE tx_id = NEW.id)
   WHERE id = NEW.id;
END;

-- Repair, in this order. Idempotent: after one pass no row matches >= 1e12.
UPDATE subscriptions
   SET cursor = COALESCE((SELECT MAX(cursor_seq) FROM transactions WHERE cursor_seq < 1000000000000), 0)
 WHERE cursor >= 1000000000000;

INSERT INTO tx_cursor_seq (tx_id)
  SELECT id FROM transactions
   WHERE cursor_seq >= 1000000000000
     AND NOT EXISTS (SELECT 1 FROM tx_cursor_seq s WHERE s.tx_id = transactions.id)
   ORDER BY cursor_seq ASC, created_at ASC, id ASC;

UPDATE transactions
   SET cursor_seq = (SELECT MAX(s.seq) FROM tx_cursor_seq s WHERE s.tx_id = transactions.id)
 WHERE cursor_seq >= 1000000000000
   AND EXISTS (SELECT 1 FROM tx_cursor_seq s WHERE s.tx_id = transactions.id);
