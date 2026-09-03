import "server-only";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { buildAuthentikAuthorizationRequest, OIDC_FLOW_COOKIE_NAME } from "@/lib/auth/oidc";
import { safeRedirectPath } from "@/lib/safe-redirect";

export async function GET(request: Request) {
  const next = new URL(request.url).searchParams.get("next");
  const { authorizationUrl, flowState } = await buildAuthentikAuthorizationRequest(
    next ? safeRedirectPath(next) : undefined,
  );

  const cookieStore = await cookies();
  cookieStore.set(OIDC_FLOW_COOKIE_NAME, JSON.stringify(flowState), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600,
    path: "/api/auth/authentik",
  });

  return NextResponse.redirect(authorizationUrl);
}
