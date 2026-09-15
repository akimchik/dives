import { describe, expect, it, vi } from "vitest";

import { withActionTelemetry } from "@/lib/action-otel";

describe("withActionTelemetry", () => {
  it("returns the wrapped function's result unchanged", async () => {
    const result = await withActionTelemetry("noop", () => null, async () => ({ ok: true }));
    expect(result).toEqual({ ok: true });
  });

  it("rethrows the exact error thrown by the wrapped function", async () => {
    const boom = new Error("boom");

    await expect(
      withActionTelemetry("boom", () => null, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  it("rethrows Next.js redirect control-flow errors untouched", async () => {
    // Matches the shape next/navigation's redirect() actually throws (and how the test suite's
    // own next/navigation mocks reproduce it, e.g. tests/integration/padi-actions.test.ts).
    const redirectError = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/dashboard;307;",
    });

    await expect(
      withActionTelemetry("redirecting", () => null, async () => {
        throw redirectError;
      }),
    ).rejects.toBe(redirectError);
  });

  it("resolves the user lazily so login-style actions can assign it mid-flow", async () => {
    let resolvedUser: { id: string; email: string } | null = null;
    const getUser = vi.fn(() => resolvedUser);

    await withActionTelemetry("login", getUser, async () => {
      resolvedUser = { id: "1", email: "diver@aleksandr.vin" };
      return { ok: true };
    });

    // Called from the wrapper's own finally block, after fn() already assigned resolvedUser --
    // proves the label reflects the post-assignment value rather than a snapshot taken up front.
    expect(getUser).toHaveBeenCalled();
    expect(getUser.mock.results.at(-1)?.value).toEqual({ id: "1", email: "diver@aleksandr.vin" });
  });
});
