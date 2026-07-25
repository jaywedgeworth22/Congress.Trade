import re

with open('scripts/inject_competitor_data.ts', 'r') as f:
    code = f.read()

code = code.replace(
'''  const dbRows = await env.DB.prepare("SELECT filer_name, ticker, tx_date, tx_type FROM transactions").all<{
    filer_name: string; ticker: string; tx_date: string; tx_type: string;
  }>();''',
'''  const dbRows = await env.DB.prepare("SELECT f.last_name as filer_name, t.ticker, t.tx_date, t.tx_type FROM transactions t JOIN filers f ON t.filer_id = f.id").all<{
    filer_name: string; ticker: string; tx_date: string; tx_type: string;
  }>();''')

with open('scripts/inject_competitor_data.ts', 'w') as f:
    f.write(code)

