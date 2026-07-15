import { execSync } from 'child_process';
const staleBefore = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const sql = `SELECT t.ticker AS ticker
       FROM transactions t
       LEFT JOIN securities_ref sr ON sr.ticker = t.ticker
       LEFT JOIN (
         SELECT ticker, MAX(date) AS latest_price_date
           FROM price_eod
          GROUP BY ticker
       ) p ON p.ticker = t.ticker
      WHERE t.ticker IS NOT NULL AND t.ticker <> '' AND t.tx_date IS NOT NULL
        AND (
          p.latest_price_date IS NULL OR
          sr.current_price_date IS NULL OR
          p.latest_price_date < '${staleBefore}' OR
          sr.current_price_date < '${staleBefore}'
        )
      GROUP BY t.ticker
      ORDER BY MAX(t.cursor_seq) DESC
      LIMIT 10`;
const res = execSync(`npx wrangler d1 execute DB --remote --command="${sql}"`).toString();
console.log(res);
