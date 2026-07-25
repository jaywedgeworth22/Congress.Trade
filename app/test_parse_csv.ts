import { parse } from "https://deno.land/std/csv/mod.ts";
const text = await Deno.readTextFile("../data/hoarded/our_trades.csv");
const data = parse(text, { skipFirstRow: true });
console.log(data[0]);
