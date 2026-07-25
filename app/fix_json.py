import re

with open('scripts/inject_competitor_data.ts', 'r') as f:
    code = f.read()

code = code.replace(
'''  let trumpTrades: any[] = [];
  try {
    const raw = await Deno.readTextFile('../data/hoarded/trump_trades.json');
    const lines = raw.split('\\n');
    let currentStr = '';
    for (const line of lines) {
      if (!line.trim()) continue;
      currentStr += line;
      if (line === '}') {
        trumpTrades.push(JSON.parse(currentStr));
        currentStr = '';
      }
    }
  } catch (e) {
    console.warn("Could not load trump_trades.json", e);
  }''',
'''  let trumpTrades: any[] = [];
  try {
    const raw = await Deno.readTextFile('../data/hoarded/trump_trades.json');
    const fixedStr = '[' + raw.replace(/}\\n{/g, '},{') + ']';
    trumpTrades = JSON.parse(fixedStr);
  } catch (e) {
    console.warn("Could not load trump_trades.json", e);
  }''')

with open('scripts/inject_competitor_data.ts', 'w') as f:
    f.write(code)

