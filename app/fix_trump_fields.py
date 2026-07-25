import re

with open('scripts/inject_competitor_data.ts', 'r') as f:
    code = f.read()

# Fix trump trades loop
code = code.replace(
'''  // Trump trades
  for (const t of trumpTrades) {
    if (t.Representative) {
      processTrade('quiver_trump', t.Representative, 'executive', t.Ticker, t.TransactionDate, t.Transaction, t);
    }
  }''',
'''  // Trump trades
  for (const t of trumpTrades) {
    const name = t.Representative || t.politician || 'Donald Trump';
    const ticker = t.Ticker || t.ticker;
    const date = t.TransactionDate || (t.traded ? t.traded.split(' ')[0] : null);
    const typeStr = t.Transaction || t.transaction;
    if (date && ticker) {
      processTrade('quiver_trump', name, 'executive', ticker, date, typeStr, t);
    }
  }''')

with open('scripts/inject_competitor_data.ts', 'w') as f:
    f.write(code)

