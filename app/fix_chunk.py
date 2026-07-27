import re

with open('scripts/inject_competitor_data.ts', 'r') as f:
    code = f.read()

# Fix trump_trades.json path
code = code.replace(
'''  let trumpTrades: any[] = [];
  try {
    trumpTrades = JSON.parse(await Deno.readTextFile('trump_trades.json'));
  } catch (e) {
    console.warn("Could not load trump_trades.json");
  }''',
'''  let trumpTrades: any[] = [];
  try {
    trumpTrades = JSON.parse(await Deno.readTextFile('../data/hoarded/trump_trades.json'));
  } catch (e) {
    console.warn("Could not load trump_trades.json");
  }''')

# Fix CHUNK_SIZE
code = code.replace(
'''  const CHUNK_SIZE = 500;''',
'''  const CHUNK_SIZE = 100;''')

with open('scripts/inject_competitor_data.ts', 'w') as f:
    f.write(code)

