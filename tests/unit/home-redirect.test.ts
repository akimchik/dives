import { describe, expect, it } from "vitest";

import { resolveHomeRedirect } from "@/lib/home-redirect";
import { safeRedirectPath } from "@/lib/safe-redirect";

// Regression coverage for "/" auto-redirecting straight into Authentik in production
// (passwordAuthEnabled=false) -- the e2e suite's single shared webServer always runs with
// PASSWORD_AUTH_ENABLED=true, so this path has no e2e coverage of its own. See lib/home-redirect.ts.
describe("resolveHomeRedirect", () => {
  it("renders the landing page (no redirect) when password auth is enabled, regardless of next/error", () => {
    expect(resolveHomeRedirect({ passwordAuthEnabled: true })).toBeNull();
    expect(resolveHomeRedirect({ passwordAuthEnabled: true, next: "/dives/5" })).toBeNull();
    expect(resolveHomeRedirect({ passwordAuthEnabled: true, error: "oidc_failed" })).toBeNull();
  });

  it("redirects straight to Authentik in Authentik-only mode with no error", () => {
    expect(resolveHomeRedirect({ passwordAuthEnabled: false })).toBe("/api/auth/authentik");
  });

  it("carries a next path through to the Authentik sign-in route", () => {
    expect(resolveHomeRedirect({ passwordAuthEnabled: false, next: "/dives/5" })).toBe(
      "/api/auth/authentik?next=%2Fdives%2F5",
    );
  });

  it("does NOT auto-redirect after a failed attempt, so the error can actually be shown", () => {
    expect(resolveHomeRedirect({ passwordAuthEnabled: false, error: "oidc_failed" })).toBeNull();
  });

  it("never forwards an unsafe next path to Authentik (open-redirect guard)", () => {
    expect(resolveHomeRedirect({ passwordAuthEnabled: false, next: "//evil.com" })).toBe(
      "/api/auth/authentik?next=%2Fdashboard",
    );
    expect(resolveHomeRedirect({ passwordAuthEnabled: false, next: "https://evil.com" })).toBe(
      "/api/auth/authentik?next=%2Fdashboard",
    );
  });
});

describe("safeRedirectPath", () => {
  it("passes through a same-origin relative path", () => {
    expect(safeRedirectPath("/dives/5")).toBe("/dives/5");
  });

  it("falls back to /dashboard for missing, protocol-relative, or absolute values", () => {
    expect(safeRedirectPath(undefined)).toBe("/dashboard");
    expect(safeRedirectPath(null)).toBe("/dashboard");
    expect(safeRedirectPath("")).toBe("/dashboard");
    expect(safeRedirectPath("//evil.com")).toBe("/dashboard");
    expect(safeRedirectPath("https://evil.com/x")).toBe("/dashboard");
  });
});
