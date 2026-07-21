import { describe, it, expect } from "vitest";
import { SecurityRefSchema, SecurityRefInputSchema } from "../schemas";

/**
 * Guardrail test per AGENTS.md:
 * SecurityRefInputSchema (the partial/import shape) must be a true subset
 * of SecurityRefSchema (the full read-side shape). Every key in the input
 * schema must be present in the full schema.
 */
describe("SecurityRef ↔ SecurityRefInput subset consistency", () => {
  it("every key in SecurityRefInputSchema is present in SecurityRefSchema", () => {
    const refKeys = new Set(Object.keys(SecurityRefSchema.shape));
    const inputKeys = Object.keys(SecurityRefInputSchema.shape);

    const missing = inputKeys.filter((k) => !refKeys.has(k));
    expect(missing).toEqual([]);
  });

  it("SecurityRefInputSchema has the same key set as SecurityRefSchema (subset + ticker override)", () => {
    // SecurityRefInputSchema = SecurityRefSchema.partial().extend({ ticker: ... })
    // The .extend() overrides the ticker key but doesn't add new keys.
    // So the key sets should be identical.
    const refKeys = new Set(Object.keys(SecurityRefSchema.shape));
    const inputKeys = new Set(Object.keys(SecurityRefInputSchema.shape));

    // Input should have all the same keys as the ref
    for (const key of refKeys) {
      expect(inputKeys.has(key)).toBe(true);
    }

    // Input should NOT have any extra keys beyond the ref
    for (const key of inputKeys) {
      expect(refKeys.has(key)).toBe(true);
    }
  });

  it("ticker exists in both schemas", () => {
    expect("ticker" in SecurityRefSchema.shape).toBe(true);
    expect("ticker" in SecurityRefInputSchema.shape).toBe(true);
  });

  it("ticker maxLength is 20 in both import and read schemas", () => {
    expect(
      SecurityRefSchema.shape.ticker.safeParse("A".repeat(20)).success,
    ).toBe(true);
    expect(
      SecurityRefSchema.shape.ticker.safeParse("A".repeat(21)).success,
    ).toBe(false);

    expect(
      SecurityRefInputSchema.shape.ticker.safeParse("A".repeat(20)).success,
    ).toBe(true);
    expect(
      SecurityRefInputSchema.shape.ticker.safeParse("A".repeat(21)).success,
    ).toBe(false);
  });

  it("all nullable fields in SecurityRefSchema are present in SecurityRefInputSchema", () => {
    // Spot-check key nullable fields
    const nullableFields = [
      "companyName",
      "sector",
      "industry",
      "assetClass",
      "country",
      "stateHq",
      "stateOfIncorp",
      "exchange",
      "exchangeShort",
      "currency",
      "marketCap",
      "marketCapBucket",
      "sharesOutstanding",
      "ipoDate",
      "cik",
      "sicCode",
      "sicDescription",
      "source",
    ];
    for (const field of nullableFields) {
      expect(field in SecurityRefSchema.shape).toBe(true);
      expect(field in SecurityRefInputSchema.shape).toBe(true);
    }
  });
});
