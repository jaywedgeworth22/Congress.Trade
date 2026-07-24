import { parseHouseSearchHtml } from './src/ingestion/houseSource.ts';
async function test() {
  const data = new URLSearchParams({ LastName: 'Dingell', FilingYear: '2026', State: '', District: '' });
  const res = await fetch('https://disclosures-clerk.house.gov/FinancialDisclosure/ViewMemberSearchResult', { method: 'POST', body: data });
  const html = await res.text();
  const filings = parseHouseSearchHtml(html, '2026');
  console.log(filings.filter(f => f.last.includes('Dingell') && f.filingDate === '7/23/2026'));
}
test();
