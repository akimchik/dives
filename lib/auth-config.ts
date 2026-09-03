import "server-only";

// Off by default -- this app is moving to Authentik-only login (see
// AUTHENTIK-OIDC-CUSTOM-APPS.md in pumpking). The local email/password +
// magic-link flow stays in the codebase (not deleted) in case a future
// deployment needs it, but every entry point checks this flag server-side,
// not just the UI -- hiding the form alone wouldn't actually turn it off.
export function isPasswordAuthEnabled(): boolean {
  return process.env.PASSWORD_AUTH_ENABLED === "true";
}
