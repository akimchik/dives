import "server-only";

import { headers } from "next/headers";

export async function getRequestOrigin() {
  const headerList = await headers();
  const configuredBaseUrl = process.env.NEXT_PUBLIC_BASE_URL?.trim();

  if (configuredBaseUrl) return configuredBaseUrl.replace(/\/$/, "");

  const host = headerList.get("host") ?? "localhost:3000";
  const proto = headerList.get("x-forwarded-proto") ?? "http";
  return `${proto}://${host}`;
}
