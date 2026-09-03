import { describe, expect, it } from "vitest";

import { classifySmtpError, computeBackoff } from "../../../scripts/notifications/queue.mjs";

describe("computeBackoff", () => {
  it("grows exponentially in expectation and always stays within the jitter band", () => {
    const baseMs = 1000;
    const maxMs = 3_600_000;

    for (let attempts = 0; attempts <= 6; attempts += 1) {
      const uncapped = Math.min(baseMs * 2 ** attempts, maxMs);
      for (let i = 0; i < 50; i += 1) {
        const value = computeBackoff(attempts, baseMs, maxMs);
        expect(value).toBeGreaterThanOrEqual(uncapped * 0.8);
        expect(value).toBeLessThanOrEqual(uncapped * 1.2);
      }
    }
  });

  it("caps the base delay at maxMs before applying jitter", () => {
    const maxMs = 5000;
    for (let i = 0; i < 50; i += 1) {
      const value = computeBackoff(20, 1000, maxMs);
      expect(value).toBeLessThanOrEqual(maxMs * 1.2);
      expect(value).toBeGreaterThanOrEqual(maxMs * 0.8);
    }
  });
});

describe("classifySmtpError", () => {
  it("treats a 4xx SMTP reply code as retryable", () => {
    expect(classifySmtpError({ responseCode: 450 })).toBe("retryable");
    expect(classifySmtpError({ responseCode: 421 })).toBe("retryable");
  });

  it("treats a 5xx SMTP reply code as permanent", () => {
    expect(classifySmtpError({ responseCode: 550 })).toBe("permanent");
    expect(classifySmtpError({ responseCode: 501 })).toBe("permanent");
  });

  it("treats a code-less network/timeout error as retryable", () => {
    expect(classifySmtpError({ code: "ECONNECTION" })).toBe("retryable");
    expect(classifySmtpError(new Error("socket timeout"))).toBe("retryable");
  });
});
