const raw = await Deno.readTextFile('../data/hoarded/trump_trades.json');
const fixedStr = '[' + raw.replace(/}\\n{/g, '},{') + ']';
console.log(fixedStr.substring(0, 100));
try {
  const parsed = JSON.parse(fixedStr);
  console.log("Parsed", parsed.length);
} catch (e) {
  console.log("Error:", e);
}
