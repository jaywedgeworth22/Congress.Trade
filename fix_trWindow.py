with open('app/src/ui/dashboardHtml.ts', 'r') as f:
    content = f.read()

content = content.replace("el('trWindow') ? getTrWindow() : 'all'", "document.querySelector('.tr-window-select') ? getTrWindow() : 'all'")

with open('app/src/ui/dashboardHtml.ts', 'w') as f:
    f.write(content)
