import { describe, it, expect } from "vitest";
import {
  isPlaceholderTicker,
  isWellFormedTicker,
  normalizePreferredTickerVariant,
  punctuationVariants,
  resolvePreferredTickerFromAssetName,
  resolveTickerDeterministic,
  stripPreferredSeries,
} from "../utils";

// A tiny stand-in for the securities_master index used by the real resolver.
const MASTER = new Set(["T", "JPM", "RF", "AVGO", "META", "XYZ", "BRK-B", "GEHC", "AAPL"]);
const isKnown = (sym: string): string | null => (MASTER.has(sym) ? sym : null);

describe("tickerNormalize pure helpers", () => {
  it("detects placeholder / no-ticker markers", () => {
    for (const p of ["", "-", "--", "N/A", "na", "none", "  —  "]) {
      expect(isPlaceholderTicker(p)).toBe(true);
    }
    for (const real of ["AAPL", "T", "BRK.B"]) expect(isPlaceholderTicker(real)).toBe(false);
  });

  it("strips a $-series preferred/depositary suffix to the issuer symbol", () => {
    expect(stripPreferredSeries("T$A")).toBe("T");
    expect(stripPreferredSeries("RF$E")).toBe("RF");
    expect(stripPreferredSeries("AAPL")).toBe("AAPL"); // no suffix → unchanged
  });

  it("enumerates punctuation variants for class shares", () => {
    expect(punctuationVariants("BRK.B")).toEqual(expect.arrayContaining(["BRK.B", "BRKB", "BRK-B"]));
    expect(punctuationVariants("AAPL")).toEqual(["AAPL"]);
  });

  it("normalizes preferred-share ticker variants to exchange caret form", () => {
    expect(normalizePreferredTickerVariant("JPM^J")).toBe("JPM^J");
    expect(normalizePreferredTickerVariant("JPM-PJ")).toBe("JPM^J");
    expect(normalizePreferredTickerVariant("JPM.PRJ")).toBe("JPM^J");
    expect(normalizePreferredTickerVariant("JPM PR J")).toBe("JPM^J");
    expect(normalizePreferredTickerVariant("T$A")).toBe("T^A");
    expect(normalizePreferredTickerVariant("T-PA")).toBe("T^A");
    expect(normalizePreferredTickerVariant("T PRA")).toBe("T^A");
  });

  it("recognizes well-formed symbols and rejects contamination", () => {
    for (const ok of ["AAPL", "K", "NSRGY", "KRSOX", "BRK.B", "BRK-B", "JPM^J"]) {
      expect(isWellFormedTicker(ok)).toBe(true);
    }
    for (const bad of ["BANK OF AMERICA APPLE", "COMMON STOCK", "TOOLONGSYMBOL", "200?", "A B"]) {
      expect(isWellFormedTicker(bad)).toBe(false);
    }
  });
});

describe("resolveTickerDeterministic", () => {
  it("resolves preferred-share ticker variants to exchange caret form", () => {
    expect(resolveTickerDeterministic("T$A", isKnown)).toBe("T^A");
    expect(resolveTickerDeterministic("T-PA", isKnown)).toBe("T^A");
    expect(resolveTickerDeterministic("JPM-PJ", isKnown)).toBe("JPM^J");
    expect(resolveTickerDeterministic("JPM.PRJ", isKnown)).toBe("JPM^J");
    expect(resolveTickerDeterministic("JPM PR J", isKnown)).toBe("JPM^J");
  });

  it("resolves a dotted/dashed class share to the master punctuation form (BRK.B → BRK-B)", () => {
    expect(resolveTickerDeterministic("BRK.B", isKnown)).toBe("BRK-B");
    expect(resolveTickerDeterministic("BRK-B", isKnown)).toBe("BRK-B");
  });

  it("maps curated stale/renamed tickers to the current symbol", () => {
    expect(resolveTickerDeterministic("FB", isKnown)).toBe("META");
    expect(resolveTickerDeterministic("GEHCV", isKnown)).toBe("GEHC");
  });

  it("accepts a well-formed symbol the master does not list (CTRA, NSRGY)", () => {
    expect(resolveTickerDeterministic("CTRA", isKnown)).toBe("CTRA");
    expect(resolveTickerDeterministic("NSRGY", isKnown)).toBe("NSRGY");
    expect(resolveTickerDeterministic("K", isKnown)).toBe("K");
  });

  it("rejects placeholders and header-contaminated strings", () => {
    expect(resolveTickerDeterministic("--", isKnown)).toBeNull();
    expect(resolveTickerDeterministic("N/A", isKnown)).toBeNull();
    expect(resolveTickerDeterministic("Bank of America Apple", isKnown)).toBeNull();
    expect(resolveTickerDeterministic("COMMON STOCK", isKnown)).toBeNull();
  });

  it("cleans surrounding quotes/brackets before resolving", () => {
    expect(resolveTickerDeterministic('"AAPL"', isKnown)).toBe("AAPL");
    expect(resolveTickerDeterministic("[CTRA]", isKnown)).toBe("CTRA");
  });

  it("resolves preferred/depositary descriptions from asset names", () => {
    const issuer = (name: string) => {
      const normalized = name.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
      if (normalized === "AT T INC") return "T";
      if (normalized === "JPMORGAN CHASE CO") return "JPM";
      return null;
    };

    expect(
      resolvePreferredTickerFromAssetName(
        "AT&T Inc. Depositary Shares, each representing a 1/1,000th interest in a share of 5.000% Perpetual Preferred Stock, Series A",
        issuer,
      ),
    ).toBe("T^A");
    expect(resolvePreferredTickerFromAssetName("JPMorgan Chase & Co. Depositary Shares, Series GG", issuer)).toBe("JPM^J");
    expect(resolvePreferredTickerFromAssetName("Apple Inc. Common Stock", issuer)).toBeNull();
    expect(resolvePreferredTickerFromAssetName("Example Corp Preferred Stock, Series GG", issuer)).toBeNull();
  });
});
