import { applyMemberNameAlias } from '../shared/memberIdentity.ts';

export function isJunkAssetString(s: string | null | undefined): boolean {
  if (!s) return true;
  const str = String(s).trim();
  if (!str) return true;
  const lower = str.toLowerCase();
  if (
    lower.includes('unparsed historical filing') ||
    lower.includes('this filing was disclosed via scanned pdf') ||
    lower.includes('use link in ptr_link column to view the pdf') ||
    lower.includes('pdf disclosed filing')
  ) {
    return true;
  }
  const stripped = str.replace(/[\.\s\-\_\:\;\,\?\!\[\]\(\)]/g, '');
  if (stripped.length === 0) return true;
  if (/^[\.\_\-\s\]\)]+[a-z]?$/i.test(str)) return true;
  if (/[\.\_\-]{2,}/.test(str) && stripped.length <= 2) return true;
  return false;
}

export function cleanAssetString(name: string | null | undefined, ticker?: string | null): string {
  if (!name || isJunkAssetString(name)) return '';
  let str = name.trim();

  // Strip leading/trailing dot-leaders, brackets, and orphan OCR trailing noise (e.g. "ARCC ..", ".....]", "....k")
  str = str.replace(/(?:\s*[\.]{2,}[a-z0-9\]\)]*|\s*\]+)$/i, '');
  str = str.replace(/^[.\s\]\)\-]+/, '');
  str = str.replace(/\s*\.{2,}\s*/g, ' ');

  // If the name is produced as exactly the ticker, return the uppercase ticker
  if (ticker && str.toLowerCase() === ticker.trim().toLowerCase()) {
    return ticker.toUpperCase();
  }

  // Strip state of incorporation suffix (e.g. "/DE/", "/DE", "/CA") only if it matches a US state code
  const STATES = new Set([
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
    "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
    "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
    "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
    "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY"
  ]);
  str = str.replace(/\/([a-zA-Z]{2})(?:\/|\b)/g, (match, code) => {
    if (STATES.has(code.toUpperCase())) {
      return " ";
    }
    return match;
  });
  str = str.replace(/\s{2,}/g, " ").trim();

  // 1. Remove trailing stock exchanges in parentheses (e.g. "(NYSE)", "(NASDAQ: AAPL)")
  str = str.replace(/\s*\([A-Z]+(?:\s*:\s*[A-Z]+)?\)\s*$/i, '');

  // 2. Remove trailing slash
  str = str.replace(/\/\s*$/g, '');

  // 3. Title case if the string is primarily ALL CAPS.
  const upperCount = (str.match(/[A-Z]/g) || []).length;
  const lowerCount = (str.match(/[a-z]/g) || []).length;
  
  if (upperCount > 0 && upperCount > lowerCount * 2) {
    let wordIndex = 0;
    str = str.replace(/[A-Za-z0-9]+/g, (txt) => {
      const isFirstWord = wordIndex++ === 0;
      const upper = txt.toUpperCase();
      if (upper === 'INC') return 'Inc.';
      if (upper === 'COM') return 'com';
      if (upper === 'CO') return 'Co.';
      if (upper === 'LTD') return 'Ltd.';
      if (upper === 'CORP') return 'Corp.';
      if (['THE', 'AND', 'FOR', 'OF', 'IN', 'ON', 'AT', 'TO'].includes(upper)) {
        return isFirstWord ? txt.charAt(0).toUpperCase() + txt.substring(1).toLowerCase() : txt.toLowerCase();
      }
      
      // Keep acronyms (e.g., IBM, CBS, LLC, ETF, USA) uppercase if 3 chars or fewer without vowels
      if (txt.length <= 3 && txt.toUpperCase() === txt && !/[AEIOU]/i.test(txt)) {
        return txt;
      }
      return txt.charAt(0).toUpperCase() + txt.substring(1).toLowerCase();
    });
  }

  // 4. Entity normalizations (case-insensitive)
  str = str.replace(/(?:\s*(?:-)?\s*Common Stock\b)/ig, '');
  str = str.replace(/\bAmazon\s+Com\s+Inc\.?\b/gi, 'Amazon.com, Inc.');
  str = str.replace(/\bAmazon\.com\s+Inc\.?\b/gi, 'Amazon.com, Inc.');
  str = str.replace(/\bMeta\s+Platforms\s+Inc\.?\b/gi, 'Meta Platforms, Inc.');
  str = str.replace(/\bINC(?:\.|\b)/gi, 'Inc.');
  str = str.replace(/\bL\.?L\.?C(?:\.|\b)/gi, 'LLC');
  str = str.replace(/\bL\.?P(?:\.|\b)/gi, 'LP');
  str = str.replace(/\bCORP(?:\.|\b)/gi, 'Corp.');
  str = str.replace(/\bCO(?:\.|\b)(?=\s|$)/gi, 'Co.'); // Only match "Co." at end of string or before space
  str = str.replace(/\bLTD(?:\.|\b)/gi, 'Ltd.');

  // Clean up any double spaces or spaces before punctuation
  str = str.replace(/\s+([.,])/g, '$1');
  str = str.replace(/\s{2,}/g, ' ');

  return str.trim();
}

export function cleanFilerName(name: string | null | undefined): string {
  if (!name) return '';
  let str = name.trim();

  // Strip standalone honorifics and professional titles wherever a source
  // embedded them in the member's name (for example, "Richard Dean Dr
  // McCormick" or "Neal Patrick MD, Facs Dunn"). Do not match substrings in
  // ordinary names such as Drake or Senatorial.
  str = str.replace(
    /(?:,\s*)?\b(?:DR|HON|MR|MRS|MS|REP|SEN|MD|FACS|PH\.?D\.?)\b(?:,\s*)?/gi,
    ' ',
  );
  
  // Strip "(Senator)" or ", Senator"
  str = str.replace(/\s*\(Senator\)\s*/gi, ' ');
  str = str.replace(/,\s*Senator\b/gi, ' ');

  // If it's formatted as "Last, First" (e.g. "Boozman, John" or "McCormick, David H.")
  if (/^[A-Za-z\-]+,\s*[A-Za-z\s.\-]+$/.test(str)) {
    const parts = str.split(',');
    str = parts[1].trim() + ' ' + parts[0].trim();
  }

  // Title case if the string is primarily ALL CAPS.
  const upperCount = (str.match(/[A-Z]/g) || []).length;
  const lowerCount = (str.match(/[a-z]/g) || []).length;
  if (upperCount > 0 && upperCount > lowerCount * 2) {
    str = str.toLowerCase().replace(/(^|\s|-|\.)\w/g, (c) => c.toUpperCase());
  }

  // Clean up any trailing commas, spaces, or stray periods
  str = str.replace(/[,\s.]+$/, '');
  str = str.replace(/\s{2,}/g, ' ');

  // Curated legal → preferred renames (e.g. Rohit Khanna → Ro Khanna).
  // Applied last so "Khanna, Rohit" is already flipped to "Rohit Khanna".
  str = applyMemberNameAlias(str.trim());

  return str.trim();
}
