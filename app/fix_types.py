import re

with open('src/shared/types.ts', 'r') as f:
    code = f.read()

code = code.replace(
"export type TxSource = 'primary' | 'seed_dataset' | 'manual';",
"export type TxSource = 'primary' | 'seed_dataset' | 'manual' | 'competitor_backfill';")

with open('src/shared/types.ts', 'w') as f:
    f.write(code)

