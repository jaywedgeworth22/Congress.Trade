import re

with open('scripts/inject_competitor_data.ts', 'r') as f:
    code = f.read()

code = code.replace("      estValue: 7500,\n", "")

with open('scripts/inject_competitor_data.ts', 'w') as f:
    f.write(code)

