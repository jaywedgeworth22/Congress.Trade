/** Standardize company name: title-case all-caps, normalize common suffixes, preserve key acronyms. */
export function normalizeCompanyName(raw: string | null | undefined, ticker?: string | null): string | null {
  if (!raw) return null;
  let name = raw.trim();
  if (!name) return null;

  // 1. Remove trailing stock exchanges in parentheses (e.g. "(NYSE)", "(NASDAQ: AAPL)")
  name = name.replace(/\s*\([A-Z]+(?:\s*:\s*[A-Z]+)?\)\s*$/i, "");

  // 2. Strip state of incorporation suffix (e.g. "/DE/", "/DE", "/CA") only if it matches a US state code
  const STATES = new Set([
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
    "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
    "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
    "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
    "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY"
  ]);
  name = name.replace(/\/([a-zA-Z]{2})(?:\/|\b)/g, (match, code) => {
    if (STATES.has(code.toUpperCase())) {
      return " ";
    }
    return match;
  });
  name = name.replace(/\s{2,}/g, " ").trim();

  // 3. Remove trailing slash
  name = name.replace(/\/\s*$/g, "");

  // 4. Remove "Common Stock", " - Common Stock", etc.
  name = name.replace(/(?:\s*(?:-)?\s*Common Stock\b)/ig, "").trim();

  // If the name is exactly the ticker (case-insensitive), just return the uppercase ticker.
  if (ticker && name.toLowerCase() === ticker.trim().toLowerCase()) {
    return ticker.toUpperCase();
  }

  // Token map for casing corrections and abbreviations (lowercase key -> exact casing replacement)
  const TOKEN_MAP: Record<string, string> = {
    // Suffixes
    inc: "Inc.",
    "inc.": "Inc.",
    llc: "LLC",
    "llc.": "LLC",
    llp: "LLP",
    "llp.": "LLP",
    plc: "PLC",
    "plc.": "PLC",
    corp: "Corp.",
    "corp.": "Corp.",
    co: "Co.",
    "co.": "Co.",
    ltd: "Ltd.",
    "ltd.": "Ltd.",
    lp: "LP",
    "lp.": "LP",
    nv: "NV",
    "nv.": "NV",
    ag: "AG",
    "ag.": "AG",
    sa: "SA",
    "sa.": "SA",
    bv: "BV",
    "bv.": "BV",
    // Acronyms
    cbs: "CBS",
    ibm: "IBM",
    att: "AT&T",
    amd: "AMD",
    bp: "BP",
    kkr: "KKR",
    msci: "MSCI",
    nrg: "NRG",
    pnc: "PNC",
    ubs: "UBS",
    etf: "ETF",
    reit: "REIT",
    usa: "USA",
    sec: "SEC",
    nyse: "NYSE",
    nasdaq: "NASDAQ",
    spdr: "SPDR",
    tsmc: "TSMC",
    asml: "ASML",
  };

  const KEEP_UPPER = new Set([
    "IBM",
    "GE",
    "CDW",
    "AT&T",
    "HP",
    "AMD",
    "LPL",
    "ST",
    "BEP",
    "BWXT",
    "LUV",
    "TPR",
    "SCI",
    "WRB",
    "ABT",
    "FLEX",
    "TSCO",
  ]);

  // 4. Word by word normalization
  let wordIndex = 0;
  name = name.replace(/[A-Za-z0-9&]+/g, (word) => {
    wordIndex++;

    // Check if the word matches the ticker (e.g. "Nvda" -> "NVDA")
    if (ticker && word.toLowerCase() === ticker.toLowerCase()) {
      return ticker.toUpperCase();
    }

    // If word is entirely uppercase
    if (word.toUpperCase() === word && /[A-Z]/.test(word)) {
      if (word.length <= 4 && !/[AEIOUY]/.test(word)) {
        return word; // e.g. "LPL", "BWXT" - keep upper
      }
      if (KEEP_UPPER.has(word)) return word;

      // Small words that shouldn't be capitalized in standard title case (unless first word)
      if (["THE", "AND", "FOR", "OF", "IN", "ON", "AT", "TO"].includes(word)) {
        return wordIndex === 1
          ? word.charAt(0).toUpperCase() + word.substring(1).toLowerCase()
          : word.toLowerCase();
      }

      // Title case it
      return word.charAt(0).toUpperCase() + word.substring(1).toLowerCase();
    }

    // If word is entirely lowercase and > 1 char
    if (word.toLowerCase() === word && word.length > 1 && /[a-z]/.test(word)) {
      if (["the", "and", "for", "of", "in", "on", "at", "to"].includes(word)) {
        return wordIndex === 1
          ? word.charAt(0).toUpperCase() + word.substring(1).toLowerCase()
          : word;
      }
      return word.charAt(0).toUpperCase() + word.substring(1);
    }

    return word;
  });

  // 5. Entity normalizations (case-insensitive)
  // We use regex to specifically match entity boundaries and map them
  name = name.replace(/\b([a-zA-Z&]+)(\.|\b)/g, (match, word, dot) => {
    const key = (word + (dot || "")).toLowerCase();
    const cleanKey = word.toLowerCase();
    if (TOKEN_MAP[key]) {
      return TOKEN_MAP[key];
    }
    if (TOKEN_MAP[cleanKey]) {
      return TOKEN_MAP[cleanKey];
    }
    return match;
  });

  // Deduplicate double spaces and double periods
  name = name.replace(/\s+([.,])/g, "$1");
  name = name.replace(/\s{2,}/g, " ");
  name = name.replace(/\.{2,}/g, ".");

  return name.trim();
}
