import re

with open('clients/pwa/app/ui/Dashboard.tsx', 'r') as f:
    content = f.read()

if 'import { Trends }' not in content:
    content = content.replace("import { TradeTable } from './TradeTable';", "import { TradeTable } from './TradeTable';\nimport { Trends } from './Trends';")

# Add Trends section above Control Panel
if 'id="trends"' not in content:
    trends_section = """
      <section className="feed-list" id="trends" aria-label="Market Trends">
        <Trends />
      </section>
"""
    content = content.replace('<section className="control-panel" id="controls"', trends_section + '\n      <section className="control-panel" id="controls"')

# Add Trends to bottom nav
if 'href="#trends"' not in content:
    content = content.replace('<a href="#feed">Feed</a>', '<a href="#feed">Feed</a>\n        <a href="#trends">Trends</a>')

with open('clients/pwa/app/ui/Dashboard.tsx', 'w') as f:
    f.write(content)
