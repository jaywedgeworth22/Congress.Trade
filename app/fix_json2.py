import re

with open('scripts/inject_competitor_data.ts', 'r') as f:
    code = f.read()

code = code.replace(
'''    const fixedStr = '[' + raw.replace(/}\\n{/g, '},{') + ']';''',
'''    const fixedStr = '[' + raw.replace(/}\\r?\\n{/g, '},{') + ']';''')

with open('scripts/inject_competitor_data.ts', 'w') as f:
    f.write(code)

