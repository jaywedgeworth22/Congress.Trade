import re

with open('scripts/inject_competitor_data.ts', 'r') as f:
    code = f.read()

# Fix UnusualWhales
code = code.replace(
'''  // unusual whales
  for (const t of uwTrades) {
    if (t.politician_name) {
      processTrade('uw', t.politician_name, t.party?.toLowerCase() === 'democrat' ? 'house' : 'senate', t.ticker, t.transaction_date, t.transaction_type, t);
    }
  }''',
'''  // unusual whales
  for (const t of uwTrades) {
    const name = t.name || t.reporter || t.politician_name;
    if (name) {
      processTrade('uw', name, t.party?.toLowerCase() === 'democrat' ? 'house' : 'senate', t.ticker, t.transaction_date, t.txn_type || t.type || t.transaction_type || 'buy', t);
    }
  }''')

# Fix FMP
code = code.replace(
'''  // FMP
  for (const t of fmpHouse) processTrade('fmp', t.representative, 'house', t.ticker, t.transactionDate, t.type, t);
  for (const t of fmpSenate) processTrade('fmp', t.representative, 'senate', t.ticker, t.transactionDate, t.type, t);''',
'''  // FMP
  for (const t of fmpHouse) processTrade('fmp', `${t.firstName} ${t.lastName}`, 'house', t.symbol, t.transactionDate, t.type, t);
  for (const t of fmpSenate) processTrade('fmp', `${t.firstName} ${t.lastName}`, 'senate', t.symbol, t.transactionDate, t.type, t);''')

# Fix typeStr
code = code.replace(
'''    const type = typeStr.toLowerCase().includes('buy') || typeStr.toLowerCase().includes('purchase') ? 'buy' :
                 typeStr.toLowerCase().includes('sell') || typeStr.toLowerCase().includes('sale') ? 'sell' : 'exchange';''',
'''    const tStr = (typeStr || '').toLowerCase();
    const type = tStr.includes('buy') || tStr.includes('purchase') ? 'buy' :
                 tStr.includes('sell') || tStr.includes('sale') ? 'sell' : 'exchange';''')

with open('scripts/inject_competitor_data.ts', 'w') as f:
    f.write(code)

