// Shared by every place that reflects a caller-supplied "come back here after auth" path (the
// sign-in form's `next`, requireUser's redirect, the OIDC flow cookie) -- a same-origin, relative
// path only, never an absolute/protocol-relative URL an attacker could use as an open redirect.
export function safeRedirectPath(nextPath?: string | null): string {
  if (!nextPath) return "/dashboard";
  if (!nextPath.startsWith("/") || nextPath.startsWith("//")) return "/dashboard";

  return nextPath;
}
