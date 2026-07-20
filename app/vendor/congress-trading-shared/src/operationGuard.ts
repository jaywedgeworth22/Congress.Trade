import { z } from "zod";

export const OperationGuardRateLimitedSchema = z.object({
  code: z.literal("rate_limited"),
  operation: z.string().min(1),
  retryAfterSeconds: z.number().int().positive(),
});
export type OperationGuardRateLimited = z.infer<typeof OperationGuardRateLimitedSchema>;

export const OperationGuardInFlightSchema = z.object({
  code: z.literal("operation_in_flight"),
  operation: z.string().min(1),
  activeOperation: z.string().min(1),
});
export type OperationGuardInFlight = z.infer<typeof OperationGuardInFlightSchema>;

export const OperationGuardRejectionSchema = z.discriminatedUnion("code", [
  OperationGuardRateLimitedSchema,
  OperationGuardInFlightSchema,
]);
export type OperationGuardRejection = z.infer<typeof OperationGuardRejectionSchema>;

export function buildRateLimitedRejection(operation: string, retryAfterSeconds: number): OperationGuardRateLimited {
  return OperationGuardRateLimitedSchema.parse({
    code: "rate_limited",
    operation,
    retryAfterSeconds,
  });
}

export function buildOperationInFlightRejection(operation: string, activeOperation: string): OperationGuardInFlight {
  return OperationGuardInFlightSchema.parse({
    code: "operation_in_flight",
    operation,
    activeOperation,
  });
}

export function getOperationGuardHttpStatus(rejection: OperationGuardRejection): number {
  switch (rejection.code) {
    case "rate_limited":
      return 429;
    case "operation_in_flight":
      return 409;
  }
}
