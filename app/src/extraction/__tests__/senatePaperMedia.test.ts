import { describe, it, expect } from 'vitest';
import {
  extractSenatePaperMediaUrls,
  isSenatePaperViewerHtml,
} from '../senatePaperMedia.ts';

const PAPER_SHELL = `<!DOCTYPE HTML><html><title>eFD: View Report</title>
<body>
Page 1 of 5
<img class="filingImage" src="https://efd-media-public.senate.gov/media/2026/2/000/000/000000145.gif" alt="filing document" />
<img class="filingImage" src="https://efd-media-public.senate.gov/media/2026/2/000/000/000000146.gif" alt="filing document" />
<a href="/search/print/paper/3a4c5095-028a-4614-a692-836719da4e63/">Printer-Friendly</a>
</body></html>`;

const ELECTRONIC_PTR = `<!DOCTYPE HTML><html><table class="report-data">
<tr><th>Transaction Date</th><th>Ticker</th><th>Type</th><th>Amount</th></tr>
<tr><td>06/01/2026</td><td>AAPL</td><td>Purchase</td><td>$1,001 - $15,000</td></tr>
</table></html>`;

describe('senate paper media URL extraction', () => {
  it('detects paper viewer shells', () => {
    expect(isSenatePaperViewerHtml(PAPER_SHELL)).toBe(true);
    expect(isSenatePaperViewerHtml(ELECTRONIC_PTR)).toBe(false);
  });

  it('collects efd-media-public filingImage URLs in order', () => {
    const urls = extractSenatePaperMediaUrls(PAPER_SHELL);
    expect(urls).toEqual([
      'https://efd-media-public.senate.gov/media/2026/2/000/000/000000145.gif',
      'https://efd-media-public.senate.gov/media/2026/2/000/000/000000146.gif',
    ]);
  });

  it('ignores non-media hosts and dedupes', () => {
    const html = `
      <img class="filingImage" src="https://efd-media-public.senate.gov/media/a.gif" />
      <img class="filingImage" src="https://efd-media-public.senate.gov/media/a.gif" />
      <img class="filingImage" src="https://evil.example/media/x.gif" />
      <img src="/static/images/logo.svg" />
    `;
    expect(extractSenatePaperMediaUrls(html)).toEqual([
      'https://efd-media-public.senate.gov/media/a.gif',
    ]);
  });
});
