import { describe, expect, it, vi } from "vitest";

import { resultStatus, userLabel, withActionTelemetry } from "@/lib/action-otel";

describe("resultStatus", () => {
  it("labels a { ok: false } discriminated-union result as failure", () => {
    expect(resultStatus({ ok: false, error: "Dive not found." })).toBe("failure");
  });

  it("labels a { ok: true } discriminated-union result as success", () => {
    expect(resultStatus({ ok: true, id: 1 })).toBe("success");
  });

  // app/actions/auth.ts's AuthActionState uses this convention instead of { ok } -- this is the
  // exact shape a code review caught being silently mislabeled "success" before this test existed.
  it("labels a truthy { error } result (auth.ts's AuthActionState convention) as failure", () => {
    expect(resultStatus({ error: "Invalid email or password." })).toBe("failure");
  });

  it("labels a { error: undefined } result (AuthActionState's success case) as success", () => {
    expect(resultStatus({ error: undefined })).toBe("success");
  });

  it("labels a bare array/primitive result (e.g. searchDiveSitesAction) as success", () => {
    expect(resultStatus([])).toBe("success");
    expect(resultStatus(undefined)).toBe("success");
  });
});

describe("userLabel", () => {
  it("prefers the user's email", () => {
    expect(userLabel({ id: "1", email: "diver@aleksandr.vin" })).toBe("diver@aleksandr.vin");
  });

  it("falls back to a stable user id when email is missing", () => {
    expect(userLabel({ id: "1", email: null })).toBe("user:1");
    expect(userLabel({ id: "1" })).toBe("user:1");
  });

  it("labels an unauthenticated call as anonymous", () => {
    expect(userLabel(null)).toBe("anonymous");
  });
});

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
