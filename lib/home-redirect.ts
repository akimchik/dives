import { safeRedirectPath } from "@/lib/safe-redirect";

/**
 * Decides what "/" should do for an unauthenticated visitor. Pulled out of the page component so
 * this can be unit-tested directly -- the actual redirect() call and landing-page render can't be,
 * and the e2e suite only ever exercises the passwordAuthEnabled=true path (a fixed env var for the
 * whole Playwright webServer process, so the Authentik-only path has no e2e coverage of its own;
 * this is that coverage instead).
 *
 * Returns the path to redirect to, or null to render the landing page. In Authentik-only mode
 * there's nothing left to choose on the landing page (no password field, no sign-up) -- its one
 * button just sends the browser to the same place -- so skip straight there, except right after a
 * failed attempt (redirecting back into the thing that just failed, with no visible error, would
 * silently loop the user).
 */
export function resolveHomeRedirect(options: {
  passwordAuthEnabled: boolean;
  next?: string;
  error?: string;
}): string | null {
  if (options.passwordAuthEnabled || options.error) return null;

  return options.next
    ? `/api/auth/authentik?next=${encodeURIComponent(safeRedirectPath(options.next))}`
    : "/api/auth/authentik";
}
