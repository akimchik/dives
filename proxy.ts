import { NextResponse } from "next/server";

import { isDevStage } from "@/lib/deployment-stage";

// Renamed from middleware.ts in Next.js 16 -- see
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md
export function proxy() {
  const response = NextResponse.next();

  if (isDevStage()) {
    response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  }

  return response;
}

export const config = {
  matcher: "/((?!_next/static|_next/image|favicon.ico).*)",
};
