import re

with open('src/analytics/quality.ts', 'r') as f:
    code = f.read()

# Update ObservationRow interface
code = code.replace(
'''interface ObservationRow {
  provider: string;
  chamber: string;
  provider_key: string;
  first_observed_at: string;
  provider_published_at: string | null;
  source_url: string | null;
  filed_date: string | null;
  filer_name: string | null;
  payload: string | null;
}''',
'''interface ObservationRow {
  trade_hash: string;
  provider: string;
  chamber: string;
  provider_key: string;
  first_observed_at: string;
  provider_published_at: string | null;
  source_url: string | null;
  filed_date: string | null;
  filer_name: string | null;
  payload: string | null;
}''')

with open('src/analytics/quality.ts', 'w') as f:
    f.write(code)
