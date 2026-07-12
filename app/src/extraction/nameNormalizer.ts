export function cleanAssetString(name: string | null | undefined): string {
  if (!name) return '';
  let str = name.trim();

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
      // Small words that shouldn't be capitalized in standard title case (unless first word)
      if (['THE', 'AND', 'FOR', 'OF', 'IN', 'ON', 'AT', 'TO'].includes(txt)) {
        return isFirstWord ? txt.charAt(0).toUpperCase() + txt.substring(1).toLowerCase() : txt.toLowerCase();
      }
      
      // If it's a short word with NO vowels, it's definitely an acronym (e.g., IBM, CBS).
      // A simpler heuristic: keep <= 3 chars uppercase, except 'THE', 'AND', etc.
      if (txt.length <= 3 && txt.toUpperCase() === txt) {
        return txt;
      }
      return txt.charAt(0).toUpperCase() + txt.substring(1).toLowerCase();
    });
  }

  // 4. Entity normalizations (case-insensitive)
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

  // Strip medical and academic titles from the end of the name
  str = str.replace(/(?:,\s*)?(?:\bMD\b|\bFACS\b|\bPH\.?D\.?(?=\s|$))(?:,\s*)?/gi, ' ');
  
  // Clean up any trailing commas, spaces, or stray periods
  str = str.replace(/[,\s.]+$/, '');
  str = str.replace(/\s{2,}/g, ' ');

  return str.trim();
}
