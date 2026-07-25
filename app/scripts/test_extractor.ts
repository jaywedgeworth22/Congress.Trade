import { TextPdfExtractor } from '../src/extraction/textPdf.ts';

async function main() {
  const url = 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/9116211.pdf';
  const res = await fetch(url);
  const bytes = await res.arrayBuffer();

  const extractor = new TextPdfExtractor();

  console.log('Extracting from:', url);
  
  const input = {
    bytes,
    filing: {
      docId: 'H-2026-9116211',
      chamber: 'house',
      docKind: 'text_pdf',
      filerId: 'M001157',
    },
    signal: new AbortController().signal
  } as any;

  const result = await extractor.extract(input);
  console.log(JSON.stringify(result.transactions, null, 2));
}

main().catch(console.error);
