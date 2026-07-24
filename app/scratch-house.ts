import { fetchHouseIndex } from './src/ingestion/houseSource.ts';
fetchHouseIndex(2026).then(filings => {
  const dingell = filings.filter(f => f.last.includes("Dingell") && f.filingDate === "7/23/2026");
  console.log(dingell);
});
