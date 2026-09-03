import "server-only";

import * as client from "openid-client";

export const OIDC_FLOW_COOKIE_NAME = "dives_oidc_flow";
const OIDC_CALLBACK_PATH = "/api/auth/authentik/callback";

// Discovery hits Authentik's .well-known endpoint, so it's cached on a
// module-level promise rather than re-fetched on every login attempt.
let configPromise: Promise<client.Configuration> | null = null;

export function getOidcConfig() {
  if (!configPromise) {
    configPromise = client.discovery(
      new URL(requireEnv("AUTHENTIK_ISSUER")),
      requireEnv("AUTHENTIK_CLIENT_ID"),
      requireEnv("AUTHENTIK_CLIENT_SECRET"),
    );
  }

  return configPromise;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);

  return value;
}

export type OidcFlowState = {
  codeVerifier: string;
  state: string;
  nonce: string;
  // Where to send the browser after a successful login -- carried through
  // Authentik's own redirect round-trip via this server-side cookie (not a
  // URL param Authentik would need to echo back), read by the callback
  // route via safeRedirectPath so an already-validated relative path is the
  // only thing ever stored here.
  next?: string;
};

export async function buildAuthentikAuthorizationRequest(next?: string) {
  const config = await getOidcConfig();

  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();
  const nonce = client.randomNonce();

  // Traefik terminates TLS and proxies to the pod as plain HTTP, so
  // request.url resolves as http:// here -- use the app's known external
  // base URL instead, which is what's actually registered as the
  // provider's redirect_uri in Authentik.
  const redirectUri = new URL(OIDC_CALLBACK_PATH, requireEnv("NEXT_PUBLIC_BASE_URL")).toString();

  const authorizationUrl = client.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    // "entitlements" is a custom scope (pumpking's authentik.tf attaches a
    // property mapping with this scope_name to this provider) -- omitting
    // it from the request means Authentik won't include the entitlements
    // claim at all, regardless of the provider-side mapping being present.
    // That claim is what the callback reads to grant admin (dev-dives/admin).
    scope: "openid email profile entitlements",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    nonce,
  });

  const flowState: OidcFlowState = { codeVerifier, state, nonce, next };

  return { authorizationUrl, flowState };
}
