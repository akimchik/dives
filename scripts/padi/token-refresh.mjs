import { enqueueNotification } from "../notifications/queue.mjs";
import { decryptSecret, encryptSecret } from "./crypto.mjs";
import { PadiApiError, refresh as defaultRefresh } from "./client.mjs";

// More than this many decrypt failures in one run means the encryption key itself is likely
// misconfigured (a bad deploy), not a handful of one-off row-level glitches -- see the circuit
// breaker in processPadiTokenRefresh below.
const DEFAULT_DECRYPT_FAILURE_THRESHOLD = 3;

// Refreshes a single row's tokens. A decrypt failure is classified as infrastructure (never touches
// status, never enqueues). Of the refresh call's failures, ONLY a genuine PADI rejection (HTTP 401 --
// "your refresh token is no longer valid") is allowed to flip the row to needs_reconnect. A network
// error or a non-401 status (5xx, 429, a gateway hiccup) is also classified as infrastructure --
// scripts/padi/client.mjs turns every failed fetch into a PadiApiError regardless of cause, so
// `instanceof PadiApiError` alone is not enough to tell "PADI says reconnect" apart from "PADI is
// briefly unreachable". Conflating the two would mass-disconnect and mass-email every connected user
// on a single outage, since the due-query on a ~1-hour token / 30-minute schedule typically selects
// everyone in one run. Mirrors lib/padi/sync.ts's identical 401-only classification.
async function refreshRow(client, row, { encryptionKey, previousEncryptionKey, refreshFn }) {
  const userId = row.user_id;
  const decryptField = (ciphertext, field) =>
    decryptSecret(ciphertext, encryptionKey, `${userId}:${field}`, previousEncryptionKey);
  const encryptField = (plaintext, field) => encryptSecret(plaintext, encryptionKey, `${userId}:${field}`);

  let refreshToken;
  let idToken;
  try {
    refreshToken = decryptField(row.refresh_token_encrypted, "refresh");
    idToken = decryptField(row.id_token_encrypted, "id");
  } catch (error) {
    return { outcome: "decryptFailure", userId, error };
  }

  let response;
  try {
    response = await refreshFn(refreshToken, idToken);
  } catch (error) {
    if (error instanceof PadiApiError && error.status === 401) {
      return { outcome: "needsReconnect", userId, email: row.email };
    }
    return { outcome: "refreshFailure", userId, error };
  }

  const tokens = response.tokens;
  await client.query(
    `
      update padi_integrations
      set access_token_encrypted = $1,
          refresh_token_encrypted = $2,
          id_token_encrypted = $3,
          expires_at = now() + ($4 || ' seconds')::interval,
          updated_at = now()
      where user_id = $5
    `,
    [
      encryptField(tokens.accessToken, "access"),
      encryptField(tokens.refreshToken, "refresh"),
      encryptField(tokens.idToken, "id"),
      tokens.expiresIn,
      userId,
    ],
  );

  return { outcome: "refreshed", userId };
}

// Flips the row to needs_reconnect and enqueues the reconnect email in the same transaction. The
// idempotency key is derived from the needs_reconnect_at this same update just set -- never from
// connected_at, never from randomUUID() -- so a later disconnect->reconnect->disconnect cycle for
// the same user produces a fresh, individually-notifiable key each time, while retried processing
// of the *same* still-disconnected row within/across runs hits the queue's own
// on-conflict-do-nothing and doesn't double-send.
async function markNeedsReconnect(client, userId, email) {
  await client.query("begin");
  try {
    const result = await client.query(
      `
        update padi_integrations
        set status = 'needs_reconnect', needs_reconnect_at = now(), updated_at = now()
        where user_id = $1
        returning needs_reconnect_at
      `,
      [userId],
    );

    const needsReconnectAt = new Date(result.rows[0].needs_reconnect_at).toISOString();

    await enqueueNotification(client, {
      recipientEmail: email,
      notificationType: "padi_reconnect",
      idempotencyKey: `padi-reconnect:${userId}:${needsReconnectAt}`,
      payload: { userId },
    });

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

/**
 * Refreshes every `padi_integrations` row due within 35 minutes. `refreshFn` is injectable (mirrors
 * `processNotificationQueue`'s `sendMail` injection in scripts/notifications/queue.mjs) so tests can
 * substitute a fake PADI client instead of making real HTTP calls.
 *
 * Returns `{ refreshed, needsReconnect, decryptFailures, refreshFailures, total }`. Throws (and stops
 * processing any further rows in this run) if `decryptFailures` exceeds `decryptFailureThreshold` --
 * a systemic bad-key deploy must abort loudly and visibly rather than silently degrade into
 * individual per-user reconnect prompts (a decrypt failure never reaches the needs_reconnect/enqueue
 * path on its own, so this circuit breaker is about visibility into a misconfigured key, not about
 * preventing a reconnect-email storm, which is already structurally impossible from a decrypt
 * failure alone). `refreshFailures` (network errors / non-401 PADI responses) are logged and counted
 * but never trip this breaker and never touch a row's status -- the next scheduled run simply
 * retries them.
 */
export async function processPadiTokenRefresh(
  client,
  { encryptionKey, previousEncryptionKey, refreshFn = defaultRefresh, decryptFailureThreshold = DEFAULT_DECRYPT_FAILURE_THRESHOLD, logger = console } = {},
) {
  const due = await client.query(`
    select pi.user_id, pi.refresh_token_encrypted, pi.id_token_encrypted, u.email
    from padi_integrations pi
    join users u on u.id = pi.user_id
    where pi.status = 'connected' and pi.expires_at < now() + interval '35 minutes'
    order by pi.user_id asc
  `);

  let refreshed = 0;
  let needsReconnect = 0;
  let decryptFailures = 0;
  let refreshFailures = 0;

  for (const row of due.rows) {
    const result = await refreshRow(client, row, { encryptionKey, previousEncryptionKey, refreshFn });

    if (result.outcome === "decryptFailure") {
      decryptFailures += 1;
      logger.error?.("Failed to decrypt PADI tokens for user", { userId: result.userId }, result.error);

      // Stop processing further rows the moment the breaker trips -- a systemic bad-key deploy
      // shouldn't keep grinding through the rest of the batch once it's clearly not a one-off.
      if (decryptFailures > decryptFailureThreshold) {
        throw new Error(
          `possible PADI_TOKEN_ENCRYPTION_KEY misconfiguration: ${decryptFailures}/${due.rows.length} rows failed to decrypt`,
        );
      }
      continue;
    }

    if (result.outcome === "refreshFailure") {
      refreshFailures += 1;
      logger.error?.("PADI refresh call failed (not a token rejection)", { userId: result.userId }, result.error);
      continue;
    }

    if (result.outcome === "needsReconnect") {
      await markNeedsReconnect(client, result.userId, result.email);
      needsReconnect += 1;
      continue;
    }

    refreshed += 1;
  }

  return { refreshed, needsReconnect, decryptFailures, refreshFailures, total: due.rows.length };
}
