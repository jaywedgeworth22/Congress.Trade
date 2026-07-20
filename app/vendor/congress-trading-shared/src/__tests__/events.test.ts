import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCongressEvent } from "../events";

describe("events", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T20:50:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates a basic event with type", () => {
    const event = createCongressEvent("congress.trade");
    expect(event).toEqual({
      type: "congress.trade",
      emittedAt: "2026-07-05T20:50:00.000Z",
    });
  });

  it("creates an event with data and options", () => {
    const data = { foo: "bar" };
    const event = createCongressEvent("price.eod", data, { id: "123", seq: 1 });
    expect(event).toEqual({
      type: "price.eod",
      data,
      id: "123",
      seq: 1,
      emittedAt: "2026-07-05T20:50:00.000Z",
    });
  });

  it("respects provided emittedAt", () => {
    const event = createCongressEvent("spx.eod", undefined, { emittedAt: "2025-01-01T00:00:00.000Z" });
    expect(event).toEqual({
      type: "spx.eod",
      emittedAt: "2025-01-01T00:00:00.000Z",
    });
  });

  it("keeps the generated timestamp when emittedAt is explicitly undefined", () => {
    const event = createCongressEvent("spx.eod", undefined, { emittedAt: undefined });
    expect(event.emittedAt).toBe("2026-07-05T20:50:00.000Z");
  });

  it("rejects malformed event envelopes", () => {
    expect(() => createCongressEvent(" ")).toThrow();
    expect(() => createCongressEvent("custom.event", undefined, { id: "" })).toThrow();
    expect(() => createCongressEvent("custom.event", undefined, { seq: -1 })).toThrow();
  });
});
