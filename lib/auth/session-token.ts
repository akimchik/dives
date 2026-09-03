// No `server-only`, no Next.js imports — safe for both route handlers and CLI scripts.
import { createHash } from "node:crypto";

export const SESSION_COOKIE_NAME = "dives_session";

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}
