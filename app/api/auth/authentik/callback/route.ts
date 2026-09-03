import "server-only";

import * as client from "openid-client";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { getOidcConfig, OIDC_FLOW_COOKIE_NAME, requireEnv, type OidcFlowState } from "@/lib/auth/oidc";
import { issueSession } from "@/lib/session";
import { findOrCreateOidcUser } from "@/lib/users";
import { notifyNewUserSignup } from "@/lib/user-signup-notification";
import { recordSignup, recordSignin } from "@/lib/auth-otel";

function loginFailedRedirect() {
  return NextResponse.redirect(new URL("/?error=oidc_failed", requireEnv("NEXT_PUBLIC_BASE_URL")));
}

export async function GET(request: Request) {
  const cookieStore = await cookies();
  const flowCookie = cookieStore.get(OIDC_FLOW_COOKIE_NAME)?.value;
  // Path must match the one used when the cookie was set in
  // app/api/auth/authentik/route.ts, or the browser won't actually clear it.
  cookieStore.delete({ name: OIDC_FLOW_COOKIE_NAME, path: "/api/auth/authentik" });

  if (!flowCookie) {
    console.error("OIDC callback: missing flow cookie");
    return loginFailedRedirect();
  }

  let flowState: OidcFlowState;
  try {
    flowState = JSON.parse(flowCookie);
  } catch (err) {
    console.error("OIDC callback: failed to parse flow cookie", err);
    return loginFailedRedirect();
  }

  try {
    const config = await getOidcConfig();

    // Traefik terminates TLS and proxies to the pod as plain HTTP, so
    // request.url's scheme/host are wrong here (authorizationCodeGrant
    // derives the token exchange's redirect_uri from this URL, stripping
    // only the query string) -- rebuild it against the app's known
    // external base URL, keeping the real query string (code, state).
    const canonicalUrl = new URL(requireEnv("NEXT_PUBLIC_BASE_URL") + new URL(request.url).pathname);
    canonicalUrl.search = new URL(request.url).search;

    const tokens = await client.authorizationCodeGrant(config, canonicalUrl, {
      pkceCodeVerifier: flowState.codeVerifier,
      expectedState: flowState.state,
      expectedNonce: flowState.nonce,
    });

    const claims = tokens.claims();
    const email = claims?.email;
    const sub = claims?.sub;

    if (!email || typeof email !== "string" || !sub) {
      console.error("OIDC callback: missing email or sub claim", claims);
      return loginFailedRedirect();
    }

    // "dev-dives/admin" is the entitlement pumpking's authentik.tf grants
    // for membership in the "dev-dives:admin" Authentik group -- see
    // pumpking/provisioning/users.yaml. Absent entirely (not just empty) if
    // the client didn't request the "entitlements" scope.
    const entitlements = claims?.entitlements;
    const isAdmin = Array.isArray(entitlements) && entitlements.includes("dev-dives/admin");

    const { user, created } = await findOrCreateOidcUser(sub, email, isAdmin);
    if (created) {
      recordSignup("oidc");
      await notifyNewUserSignup({ email: user.email });
    }
    // Stored so logoutAction can later use it as the id_token_hint for
    // RP-initiated logout -- see lib/session.ts's issueSession.
    const session = await issueSession(user.id, tokens.id_token);
    recordSignin("oidc");

    const response = NextResponse.redirect(new URL("/dashboard", requireEnv("NEXT_PUBLIC_BASE_URL")));
    response.cookies.set(session.cookieName, session.token, session.options);

    return response;
  } catch (err) {
    console.error("OIDC callback failed", err);
    return loginFailedRedirect();
  }
}
