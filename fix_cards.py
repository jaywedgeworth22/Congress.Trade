import re

with open('app/src/ui/dashboardHtml.ts', 'r') as f:
    content = f.read()

# 1. Update .card .v base font-size and alignment
content = content.replace(
    '.card .v { font-size: 22px; font-weight: 700; margin-top: 4px; }',
    '.card .v { font-size: 28px; font-weight: 700; margin-top: 4px; flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; line-height: 1.2; }'
)

# 2. Update .grid-cards .card to be a flex container with a min-height so we have room to center
content = content.replace(
    '.grid-cards .card { min-width:0; padding:11px 12px; border-radius:10px; }',
    '.grid-cards .card { min-width:0; padding:11px 12px; border-radius:10px; display: flex; flex-direction: column; min-height: 96px; }'
)

# Also fix the mobile font size slightly larger
content = content.replace(
    '.card .v { font-size:18px; }',
    '.card .v { font-size:24px; }'
)

with open('app/src/ui/dashboardHtml.ts', 'w') as f:
    f.write(content)
