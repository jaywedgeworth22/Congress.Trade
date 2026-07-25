import re

# Fix tradeLatency.ts
with open('src/ingestion/tradeLatency.ts', 'r') as f:
    code = f.read()

code = code.replace("import type { Transaction } from '../extraction/types.ts';", "import type { Transaction } from '../shared/types.ts';")
code = code.replace(
'''export function matchDisclosureCandidate(
  candidate: Pick<CandidateRow, 'doc_id' | 'source_url' | 'filed_date' | 'filer_name'>,
  row: DisclosureProviderRow,
): CandidateMatch | null {
  return matchDisclosureCandidate(candidate, row);
}''',
'''// Removed old signature overload''')

code = code.replace("return matchDisclosureCandidate(candidate, row);", "")

# 1257 error:
# providerRows.map((providerRow) => ({
# ... missing tradeHash
code = re.sub(
    r'(providerRows\.map\(\(providerRow\) => \(\{\n[^\}]*?payload: \w+\[i\],)',
    r'\g<1>\n      tradeHash: providerRow.tradeHash,',
    code
)

with open('src/ingestion/tradeLatency.ts', 'w') as f:
    f.write(code)


# Fix quality.ts
with open('src/analytics/quality.ts', 'r') as f:
    code = f.read()

code = code.replace("const m = matchDisclosureCandidate(candidate as any, parsed);",
"const m = matchDisclosureCandidate({ trade_hash: generateTradeHash(parsed.filerName, '', parsed.filedDate, '') } as any, parsed);")

with open('src/analytics/quality.ts', 'w') as f:
    f.write(code)

