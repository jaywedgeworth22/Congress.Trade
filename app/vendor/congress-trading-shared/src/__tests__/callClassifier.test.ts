import { describe, it, expect } from "vitest";
import {
  buildCallClassifier,
  openrouterRequestEnrichment,
  telemetryEventClassifier,
  CallClassifierContextSchema,
  type CallClassifierContext,
} from "../callClassifier";
import { UsageTelemetryEventSchema } from "../usageTelemetry";

const fullCtx: CallClassifierContext = {
  sourceApp: "congress-trade",
  environment: "production",
  service: "extraction-worker",
  feature: "openrouter-vision-extract",
  keyRef: "openrouter-primary",
  gitSha: "abc1234",
  user: "doc-job-42",
  sessionId: "run-2026-07-18",
};

describe("CallClassifierContextSchema", () => {
  it("accepts a fully-populated context", () => {
    expect(CallClassifierContextSchema.safeParse(fullCtx).success).toBe(true);
  });

  it("accepts sourceApp-only (all other fields optional)", () => {
    const result = CallClassifierContextSchema.safeParse({ sourceApp: "socratic-trade" });
    expect(result.success).toBe(true);
  });

  it("rejects a missing sourceApp", () => {
    const { sourceApp: _sourceApp, ...rest } = fullCtx;
    expect(CallClassifierContextSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a blank sourceApp", () => {
    expect(CallClassifierContextSchema.safeParse({ ...fullCtx, sourceApp: "   " }).success).toBe(false);
  });

  it("rejects a blank optional STATIC field instead of silently dropping it", () => {
    expect(CallClassifierContextSchema.safeParse({ ...fullCtx, environment: "" }).success).toBe(false);
  });

  it("collapses blank runtime-dynamic user/sessionId to absent instead of rejecting", () => {
    const result = CallClassifierContextSchema.safeParse({ ...fullCtx, user: "", sessionId: "   " });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.user).toBeUndefined();
      expect(result.data.sessionId).toBeUndefined();
    }
  });

  it("caps user and sessionId at 128 chars (OpenRouter's documented limit)", () => {
    expect(
      CallClassifierContextSchema.safeParse({ ...fullCtx, user: "x".repeat(128) }).success,
    ).toBe(true);
    expect(
      CallClassifierContextSchema.safeParse({ ...fullCtx, user: "x".repeat(129) }).success,
    ).toBe(false);
    expect(
      CallClassifierContextSchema.safeParse({ ...fullCtx, sessionId: "x".repeat(128) }).success,
    ).toBe(true);
    expect(
      CallClassifierContextSchema.safeParse({ ...fullCtx, sessionId: "x".repeat(129) }).success,
    ).toBe(false);
  });
});

describe("openrouterRequestEnrichment", () => {
  it("shapes a fully-populated context into a flat trace + top-level user/session_id", () => {
    const result = openrouterRequestEnrichment(fullCtx);
    expect(result).toEqual({
      user: "doc-job-42",
      session_id: "run-2026-07-18",
      trace: {
        sourceApp: "congress-trade",
        environment: "production",
        service: "extraction-worker",
        feature: "openrouter-vision-extract",
        keyRef: "openrouter-primary",
        gitSha: "abc1234",
      },
    });
  });

  it("never produces a bare top-level metadata field", () => {
    const result = openrouterRequestEnrichment(fullCtx);
    expect("metadata" in result).toBe(false);
  });

  it("carries classifier fields flat in trace with no metadata sub-object", () => {
    const result = openrouterRequestEnrichment(fullCtx);
    expect("metadata" in result.trace).toBe(false);
    expect(result.trace.sourceApp).toBe("congress-trade");
    expect(result.trace.environment).toBe("production");
    expect(result.trace.service).toBe("extraction-worker");
    expect(result.trace.feature).toBe("openrouter-vision-extract");
    expect(result.trace.keyRef).toBe("openrouter-primary");
    expect(result.trace.gitSha).toBe("abc1234");
  });

  it("omits undefined optional keys instead of serializing them as undefined/null", () => {
    const result = openrouterRequestEnrichment({ sourceApp: "congress-trade" });
    expect(result).toEqual({ trace: { sourceApp: "congress-trade" } });
    expect("user" in result).toBe(false);
    expect("session_id" in result).toBe(false);
    expect("environment" in result.trace).toBe(false);
    expect("service" in result.trace).toBe(false);
    expect("feature" in result.trace).toBe(false);
    expect("keyRef" in result.trace).toBe(false);
    expect("gitSha" in result.trace).toBe(false);
  });

  it("omits only the missing optional keys when some are present", () => {
    const result = openrouterRequestEnrichment({
      sourceApp: "congress-trade",
      environment: "production",
      user: "doc-job-42",
    });
    expect(result).toEqual({
      user: "doc-job-42",
      trace: { sourceApp: "congress-trade", environment: "production" },
    });
    expect("session_id" in result).toBe(false);
  });

  it("omits blank/whitespace-only user and sessionId instead of throwing (runtime-dynamic)", () => {
    const blankUser = openrouterRequestEnrichment({ sourceApp: "congress-trade", user: "" });
    expect("user" in blankUser).toBe(false);
    expect(blankUser).toEqual({ trace: { sourceApp: "congress-trade" } });

    const whitespaceBoth = openrouterRequestEnrichment({
      sourceApp: "congress-trade",
      user: "   ",
      sessionId: "  \t ",
    });
    expect("user" in whitespaceBoth).toBe(false);
    expect("session_id" in whitespaceBoth).toBe(false);
    expect(whitespaceBoth).toEqual({ trace: { sourceApp: "congress-trade" } });
  });

  it("still throws on a blank STATIC classifier field (deploy-time constant)", () => {
    expect(() => openrouterRequestEnrichment({ sourceApp: "" })).toThrow();
    expect(() =>
      openrouterRequestEnrichment({ sourceApp: "congress-trade", environment: "  " }),
    ).toThrow();
  });

  it("JSON round-trips the produced body without undefined leaking through", () => {
    const result = openrouterRequestEnrichment({ sourceApp: "congress-trade" });
    const roundTripped = JSON.parse(JSON.stringify(result));
    expect(roundTripped).toEqual(result);
  });
});

describe("telemetryEventClassifier", () => {
  it("shapes a fully-populated context into a flat classifier metadata map", () => {
    const result = telemetryEventClassifier(fullCtx);
    expect(result).toEqual({
      sourceApp: "congress-trade",
      environment: "production",
      service: "extraction-worker",
      feature: "openrouter-vision-extract",
      keyRef: "openrouter-primary",
      gitSha: "abc1234",
      user: "doc-job-42",
      sessionId: "run-2026-07-18",
    });
  });

  it("omits undefined optional keys", () => {
    const result = telemetryEventClassifier({ sourceApp: "congress-trade" });
    expect(result).toEqual({ sourceApp: "congress-trade" });
  });

  it("omits blank/whitespace-only user and sessionId instead of throwing (runtime-dynamic)", () => {
    const result = telemetryEventClassifier({
      sourceApp: "congress-trade",
      user: "",
      sessionId: "   ",
    });
    expect(result).toEqual({ sourceApp: "congress-trade" });
  });

  it("throws on an invalid context", () => {
    expect(() => telemetryEventClassifier({ sourceApp: "" })).toThrow();
  });

  it("produces a metadata map that UsageTelemetryEventSchema accepts as-is", () => {
    const classifierMetadata = telemetryEventClassifier(fullCtx);
    const result = UsageTelemetryEventSchema.safeParse({
      sourceApp: "congress-trade",
      provider: "openrouter",
      occurredAt: "2026-07-18T00:00:00.000Z",
      metadata: classifierMetadata,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.metadata).toEqual(classifierMetadata);
    }
  });
});

describe("buildCallClassifier", () => {
  it("returns both shapes for the same context", () => {
    const result = buildCallClassifier(fullCtx);
    expect(result.openrouterRequestEnrichment).toEqual(openrouterRequestEnrichment(fullCtx));
    expect(result.telemetryMetadata).toEqual(telemetryEventClassifier(fullCtx));
  });

  it("throws on an invalid context (fails before producing either shape)", () => {
    expect(() => buildCallClassifier({ sourceApp: "" })).toThrow();
  });
});
