import "server-only";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { buildAuthentikAuthorizationRequest, OIDC_FLOW_COOKIE_NAME } from "@/lib/auth/oidc";

export async function GET() {
  const { authorizationUrl, flowState } = await buildAuthentikAuthorizationRequest();

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
