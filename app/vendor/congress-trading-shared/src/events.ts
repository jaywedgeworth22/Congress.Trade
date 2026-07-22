import type { CongressEvent, CongressEventType } from "./types";
import { CongressEventSchema } from "./schemas";

/**
 * Creates a standardized CongressEvent object.
 * Automatically assigns `emittedAt` to the current ISO time if not provided.
 */
export function createCongressEvent<T = unknown>(
  type: CongressEventType | string,
  data?: T,
  options?: Omit<CongressEvent, "type" | "data">
): CongressEvent {
  const event: CongressEvent = {
    ...options,
    type,
    emittedAt: options?.emittedAt ?? new Date().toISOString(),
  };
  if (data !== undefined) {
    event.data = data;
  }
  return CongressEventSchema.parse(event);
}
