import { describe, it, expect } from 'vitest';
import { looksLikePdf, looksLikeHtml, classifyPdfBytes, decideDocKind } from '../classifier';

const enc = (s: string) => new TextEncoder().encode(s);

describe('looksLikePdf', () => {
  it('detects a %PDF- header', () => {
    expect(looksLikePdf(enc('%PDF-1.7\n...'))).toBe(true);
  });
  it('rejects non-PDF bytes', () => {
    expect(looksLikePdf(enc('<html>'))).toBe(false);
  });
});

describe('looksLikeHtml', () => {
  it('detects via content-type', () => {
    expect(looksLikeHtml('text/html; charset=utf-8', '')).toBe(true);
  });
  it('detects via markup', () => {
    expect(looksLikeHtml('', '<!DOCTYPE html><html><head>')).toBe(true);
  });
  it('rejects plain text', () => {
    expect(looksLikeHtml('text/plain', 'just words')).toBe(false);
  });
});

describe('classifyPdfBytes', () => {
  it('classifies a PDF with a /Font and text-show operators as text_pdf', () => {
    const pdf = '%PDF-1.7\n/Font <</F1 1 0 R>>\nBT /F1 12 Tf (Hello world) Tj ET';
    expect(classifyPdfBytes(enc(pdf))).toBe('text_pdf');
  });
  it('classifies an image-only PDF as scanned_pdf', () => {
    const pdf = '%PDF-1.7\n/XObject <</Im0 1 0 R>>\n/Subtype /Image /Width 1700';
    expect(classifyPdfBytes(enc(pdf))).toBe('scanned_pdf');
  });
});

describe('decideDocKind', () => {
  it('routes Senate HTML to senate_html', () => {
    const html = '<!DOCTYPE html><html><head><title>eFD</title></head><body>...</body></html>';
    expect(decideDocKind(enc(html), 'text/html', 'senate')).toBe('senate_html');
  });
  it('routes a text PDF to text_pdf', () => {
    const pdf = '%PDF-1.7\n/Font <</F1 1 0 R>> BT (x) Tj ET';
    expect(decideDocKind(enc(pdf), 'application/pdf', 'house')).toBe('text_pdf');
  });
  it('routes a scanned PDF to scanned_pdf', () => {
    const pdf = '%PDF-1.7\n/Subtype /Image /Width 2000 /Height 2600';
    expect(decideDocKind(enc(pdf), 'application/pdf', 'house')).toBe('scanned_pdf');
  });
  it('falls back to unknown for unrecognized non-HTML, non-PDF bytes', () => {
    expect(decideDocKind(enc('garbage binaryish'), 'application/octet-stream', 'senate')).toBe(
      'unknown',
    );
  });
});
