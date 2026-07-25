import re

with open('src/extraction/normalizer.ts', 'r') as f:
    code = f.read()

# Let's ensure the import is correct.
if 'recordTradeLatencyCandidates' not in code:
    code = code.replace("import { MAX_PUBLISH_TRANSACTIONS_PER_FILING } from '../shared/limits.ts';",
"import { MAX_PUBLISH_TRANSACTIONS_PER_FILING } from '../shared/limits.ts';\nimport { recordTradeLatencyCandidates } from '../ingestion/tradeLatency.ts';")
elif 'import { recordTradeLatencyCandidates' not in code:
    code = code.replace("import { MAX_PUBLISH_TRANSACTIONS_PER_FILING } from '../shared/limits.ts';",
"import { MAX_PUBLISH_TRANSACTIONS_PER_FILING } from '../shared/limits.ts';\nimport { recordTradeLatencyCandidates } from '../ingestion/tradeLatency.ts';")

with open('src/extraction/normalizer.ts', 'w') as f:
    f.write(code)

