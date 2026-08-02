-- tx_cursor_seq indexes only `seq` (its INTEGER PRIMARY KEY); every lookup
-- below is correlated on `tx_id`, as is the trigger's own MAX(seq) subquery,
-- which runs on EVERY transaction INSERT. Without this index each one
-- full-scans a table holding one row per transaction ever written, making the
-- repair O(poisoned x rows) and degrading ingestion quadratically. Must come
-- before the trigger and the repair.
CREATE INDEX IF NOT EXISTS idx_tx_cursor_seq_tx_id ON tx_cursor_seq (tx_id);

-- Sequence-authoritative cursor: no writer may supply cursor_seq. The old
-- `WHEN NEW.cursor_seq IS NULL` guard let app/scripts/backfill_holes.ts write
-- Date.now() epochs, which permanently outranked the real sequence.
--
-- Create the replacement under a NEW NAME and drop v1 only afterwards. A
-- DROP-then-CREATE on the same name leaves a window with NO trigger, and
-- /migrate runs statements as independent round-trips with no enclosing
-- transaction — so a concurrent INSERT lands with cursor_seq = NULL, which is
-- invisible to every feed read forever and unhealable by a repair keyed on
-- `>= 1e12` (NULL >= 1e12 is NULL, never TRUE). Both triggers coexisting for a
-- moment is harmless: the row consumes two sequence values and keeps the larger.
CREATE TRIGGER IF NOT EXISTS trg_transactions_cursor_v2
AFTER INSERT ON transactions
FOR EACH ROW
BEGIN
  INSERT INTO tx_cursor_seq (tx_id) VALUES (NEW.id);
  UPDATE transactions
     SET cursor_seq = (SELECT MAX(seq) FROM tx_cursor_seq WHERE tx_id = NEW.id)
   WHERE id = NEW.id;
END;

DROP TRIGGER IF EXISTS trg_transactions_cursor;

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

-- Heal rows that lost cursor_seq entirely (any INSERT during a historical
-- no-trigger window). A NULL cursor_seq is worse than a poisoned one:
-- `t.cursor_seq > ?` is applied on EVERY /transactions read (since defaults to
-- 0) and by the SSE backlog drain, so the trade is silently invisible to the
-- whole feed and to every alert. The >= 1e12 repair above cannot reach these.
INSERT INTO tx_cursor_seq (tx_id)
  SELECT id FROM transactions
   WHERE cursor_seq IS NULL
     AND NOT EXISTS (SELECT 1 FROM tx_cursor_seq s WHERE s.tx_id = transactions.id)
   ORDER BY created_at ASC, id ASC;

UPDATE transactions
   SET cursor_seq = (SELECT MAX(s.seq) FROM tx_cursor_seq s WHERE s.tx_id = transactions.id)
 WHERE cursor_seq IS NULL
   AND EXISTS (SELECT 1 FROM tx_cursor_seq s WHERE s.tx_id = transactions.id);
