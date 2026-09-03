import "server-only";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  buildAuthentikAuthorizationRequest,
  ENROLLMENT_FLOW_SLUG,
  OIDC_FLOW_COOKIE_NAME,
  requireEnv,
} from "@/lib/auth/oidc";

export async function GET() {
  const { authorizationUrl, flowState } = await buildAuthentikAuthorizationRequest();

  // Same origin as authorizationUrl (both under AUTHENTIK_ISSUER's host) --
  // routes straight to the enrollment flow's own page instead of
  // identification, then Authentik's own `next` param sends the browser on
  // to the exact same authorize request the plain sign-in route would have
  // redirected to, completing the OIDC login once signup finishes.
  //
  // `next` must be a *relative* reference, not the full absolute URL --
  // Authentik's flow executor flatly rejects an absolute next_param with
  // "Invalid next URL" (authentik/flows/views/executor.py's
  // is_url_absolute() check), confirmed live, regardless of it being
  // same-origin. Path+query alone resolves identically here since both
  // ultimately live under the same Authentik host.
  const authentikOrigin = new URL(requireEnv("AUTHENTIK_ISSUER")).origin;
  const enrollmentUrl = new URL(`/if/flow/${ENROLLMENT_FLOW_SLUG}/`, authentikOrigin);
  enrollmentUrl.searchParams.set("next", authorizationUrl.pathname + authorizationUrl.search);

  const cookieStore = await cookies();
  cookieStore.set(OIDC_FLOW_COOKIE_NAME, JSON.stringify(flowState), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    // Unlike plain sign-in (seconds to complete), signup involves an email
    // round-trip -- the verification link itself is valid for 30 minutes
    // (dives-enrollment-verification-email's token_expiry), so a 10-minute
    // cookie (fine for sign-in) expired before the user got back, confirmed
    // live: the callback silently failed (missing flow cookie) and bounced
    // to "/", though the *Authentik* session was already live by then from
    // UserLoginStage, so a second "Sign in" click completed instantly with
    // no prompt. Matches the email link's own window, plus margin.
    maxAge: 3600,
    path: "/api/auth/authentik",
  });

  return NextResponse.redirect(enrollmentUrl);
}
