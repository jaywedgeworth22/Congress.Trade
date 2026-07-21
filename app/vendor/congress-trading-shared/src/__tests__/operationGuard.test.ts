import { describe, it, expect } from "vitest";
import {
  buildRateLimitedRejection,
  buildOperationInFlightRejection,
  getOperationGuardHttpStatus,
  OperationGuardRateLimitedSchema,
  OperationGuardInFlightSchema,
  OperationGuardRejectionSchema
} from "../operationGuard";

describe("operationGuard", () => {
  describe("buildRateLimitedRejection", () => {
    it("builds a valid rate_limited rejection", () => {
      const rejection = buildRateLimitedRejection("reindex-8k", 30);
      expect(rejection).toEqual({
        code: "rate_limited",
        operation: "reindex-8k",
        retryAfterSeconds: 30,
      });
      expect(OperationGuardRateLimitedSchema.parse(rejection)).toEqual(rejection);
      expect(OperationGuardRejectionSchema.parse(rejection)).toEqual(rejection);
    });

    it("rejects 0 retryAfterSeconds", () => {
      expect(() => buildRateLimitedRejection("reindex-8k", 0)).toThrow();
    });

    it("rejects negative retryAfterSeconds", () => {
      expect(() => buildRateLimitedRejection("reindex-8k", -1)).toThrow();
    });

    it("rejects NaN retryAfterSeconds", () => {
      expect(() => buildRateLimitedRejection("reindex-8k", NaN)).toThrow();
    });

    it("rejects Infinity retryAfterSeconds", () => {
      expect(() => buildRateLimitedRejection("reindex-8k", Infinity)).toThrow();
    });

    it("rejects fractional retryAfterSeconds", () => {
      expect(() => buildRateLimitedRejection("reindex-8k", 1.5)).toThrow();
    });

    it("rejects empty operation", () => {
      expect(() => buildRateLimitedRejection("", 30)).toThrow();
    });
  });

  describe("buildOperationInFlightRejection", () => {
    it("builds a valid operation_in_flight rejection with activeOperation", () => {
      const rejection = buildOperationInFlightRejection("reindex-8k", "some-uuid");
      expect(rejection).toEqual({
        code: "operation_in_flight",
        operation: "reindex-8k",
        activeOperation: "some-uuid",
      });
      expect(OperationGuardInFlightSchema.parse(rejection)).toEqual(rejection);
      expect(OperationGuardRejectionSchema.parse(rejection)).toEqual(rejection);
    });

    it("rejects empty operation", () => {
      expect(() => buildOperationInFlightRejection("", "some-uuid")).toThrow();
    });

    it("rejects empty activeOperation", () => {
      expect(() => buildOperationInFlightRejection("reindex-8k", "")).toThrow();
    });

    it("rejects omission of activeOperation", () => {
      expect(() => OperationGuardInFlightSchema.parse({
        code: "operation_in_flight",
        operation: "reindex-8k",
      })).toThrow();
    });
  });

  describe("getOperationGuardHttpStatus", () => {
    it("returns 429 for rate_limited", () => {
      const rejection = buildRateLimitedRejection("reindex-8k", 30);
      expect(getOperationGuardHttpStatus(rejection)).toBe(429);
    });

    it("returns 409 for operation_in_flight", () => {
      const rejection = buildOperationInFlightRejection("reindex-8k", "uuid");
      expect(getOperationGuardHttpStatus(rejection)).toBe(409);
    });
  });
});
