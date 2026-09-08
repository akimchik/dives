import "server-only";

import { queryRead } from "@/lib/db";
import { assertKeyConfigured, decryptSecret, keyFromEnvValue } from "./crypto";
import { PadiApiError, decodeIdTokenClaims } from "./client";

export type PadiCredentialsResult =
  | { ok: true; bearerToken: string; affiliateId: string }
  | { ok: false; error: string; reason: "not_connected" | "reconnect_required" | "infrastructure" };

interface PadiIntegrationTokenRow {
  id_token_encrypted: string;
  status: string;
}

// Shared by lib/padi/sync.ts and lib/padi/backup.ts: both need the same bearer token
// (the logbook API validates the JWT against its own `custom:affiliate_id` claim, so the
// idToken -- not the accessToken -- is what belongs in the Authorization header; see the
// original comment this was extracted from in sync.ts's git history) and the same
// classification of "not connected" vs "needs reconnect" vs "our own infrastructure is broken".
// Never refreshes PADI tokens itself -- that's the token-refresh CronJob's exclusive
// responsibility (scripts/padi-token-refresh.mjs); a 401 downstream means the caller needs to
// wait for the next refresh cycle or reconnect, not that this function should retry with a
// refresh of its own.
export async function getPadiCredentials(userId: string): Promise<PadiCredentialsResult> {
  const result = await queryRead<PadiIntegrationTokenRow>(
    "select id_token_encrypted, status from padi_integrations where user_id = $1",
    [userId],
  );
  const integration = result.rows[0];

  if (!integration) {
    return { ok: false, error: "PADI is not connected", reason: "not_connected" };
  }
  if (integration.status !== "connected") {
    return { ok: false, error: "PADI needs to be reconnected", reason: "reconnect_required" };
  }

  try {
    assertKeyConfigured(process.env.PADI_TOKEN_ENCRYPTION_KEY);
    const key = keyFromEnvValue(process.env.PADI_TOKEN_ENCRYPTION_KEY);
    const previousKey = process.env.PADI_TOKEN_ENCRYPTION_KEY_PREVIOUS
      ? keyFromEnvValue(process.env.PADI_TOKEN_ENCRYPTION_KEY_PREVIOUS)
      : undefined;

    const bearerToken = decryptSecret(integration.id_token_encrypted, key, `${userId}:id`, previousKey);
    const claims = decodeIdTokenClaims(bearerToken);
    if (!claims.affiliateId) throw new Error("PADI idToken is missing custom:affiliate_id");

    return { ok: true, bearerToken, affiliateId: String(claims.affiliateId) };
  } catch (error) {
    // A misconfigured/rotated-out encryption key is an infrastructure problem, never a PADI-side
    // rejection -- must never be conflated with "needs_reconnect" (see the token-refresh
    // cronjob's identical classification rule).
    console.error("PADI credential decrypt failed", error);
    return { ok: false, error: "PADI is temporarily unavailable. Please try again later.", reason: "infrastructure" };
  }
}

export function isPadiReconnectRequired(error: unknown): boolean {
  return error instanceof PadiApiError && error.status === 401;
}
