import "server-only";

import { createHmac } from "node:crypto";

import { getPool, queryRead } from "@/lib/db";

const ROLLING_WINDOW_MINUTES = 60;
const USER_ATTEMPT_LIMIT = 5;
const USERNAME_HASH_ATTEMPT_LIMIT = 20;

const PLACEHOLDER_PEPPER = "replace-with-padi-username-hash-pepper";

// HMAC (not a bare hash) so "the plaintext PADI username is never stored" is an actual property,
// not just obfuscation defeated by a dictionary lookup against `users.email` -- most PADI usernames
// are email addresses, and an unsalted/unpeppered SHA-256 of one is trivially reversible. An unset
// or still-placeholder pepper would silently degrade to exactly that (an empty or publicly-known
// key), so both are rejected outright rather than falling back to "".
export function hashUsername(username: string): string {
  const pepper = process.env.PADI_USERNAME_HASH_PEPPER;
  if (!pepper || pepper === PLACEHOLDER_PEPPER) {
    throw new Error("PADI_USERNAME_HASH_PEPPER is not configured");
  }

  return createHmac("sha256", pepper).update(username.trim().toLowerCase()).digest("hex");
}

export type RateLimitCheck = {
  userAttempts: number;
  usernameHashAttempts: number;
  exemptFromUsernameHashLimit: boolean;
};

// Two asymmetric dimensions, deliberately not symmetric (a symmetric design was found during
// planning review to let anyone lock out a victim's own connect attempts just by knowing their PADI
// email -- see the plan's v3->v4 changelog fix D):
// - user_id: the user-facing gate, tight (5/hour). Checked and enforced first by the caller.
// - username_hash: a much looser backstop (20/hour) against genuinely hammering one PADI account
//   from multiple app accounts -- exempted for a user who already has a *connected* integration on
//   that same hash, so someone else's unrelated failed attempts against the same PADI account can
//   never lock out a user who's already successfully connected it.
export async function checkRateLimit(userId: string, usernameHash: string): Promise<RateLimitCheck> {
  const [userAttemptsResult, usernameHashAttemptsResult, exemptResult] = await Promise.all([
    queryRead<{ count: string }>(
      "select count(*)::int as count from padi_login_attempts where user_id = $1 and attempted_at > now() - interval '1 minute' * $2",
      [userId, ROLLING_WINDOW_MINUTES],
    ),
    queryRead<{ count: string }>(
      "select count(*)::int as count from padi_login_attempts where username_hash = $1 and attempted_at > now() - interval '1 minute' * $2",
      [usernameHash, ROLLING_WINDOW_MINUTES],
    ),
    queryRead<{ exists: boolean }>(
      "select exists(select 1 from padi_integrations where user_id = $1 and username_hash = $2 and status = 'connected') as exists",
      [userId, usernameHash],
    ),
  ]);

  return {
    userAttempts: Number(userAttemptsResult.rows[0]?.count ?? 0),
    usernameHashAttempts: Number(usernameHashAttemptsResult.rows[0]?.count ?? 0),
    exemptFromUsernameHashLimit: exemptResult.rows[0]?.exists ?? false,
  };
}

export function isRateLimited(check: RateLimitCheck): boolean {
  if (check.userAttempts >= USER_ATTEMPT_LIMIT) return true;
  if (!check.exemptFromUsernameHashLimit && check.usernameHashAttempts >= USERNAME_HASH_ATTEMPT_LIMIT) return true;
  return false;
}

// Inserted only on a FAILED PADI login (never on success); rows age out of the rolling window
// naturally, no explicit cleanup needed at this app's volume.
export async function recordFailedAttempt(userId: string, usernameHash: string): Promise<void> {
  await getPool().query("insert into padi_login_attempts (user_id, username_hash) values ($1, $2)", [
    userId,
    usernameHash,
  ]);
}
