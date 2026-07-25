import re

with open('scripts/inject_competitor_data.ts', 'r') as f:
    code = f.read()

code = code.replace(
'''  const dbRows = await env.DB.prepare("SELECT f.last_name as filer_name, t.ticker, t.tx_date, t.tx_type FROM transactions t JOIN filers f ON t.filer_id = f.id").all<{''',
'''  const dbRows = await env.DB.prepare("SELECT f.full_name as filer_name, t.ticker, t.tx_date, t.tx_type FROM transactions t JOIN filers f ON t.filer_id = f.bioguide_id").all<{''')

with open('scripts/inject_competitor_data.ts', 'w') as f:
    f.write(code)

