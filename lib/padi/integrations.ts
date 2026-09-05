import "server-only";

import { getPool, queryRead } from "@/lib/db";
import { encryptSecret, keyFromEnvValue } from "./crypto";

export type PadiIntegrationStatus = {
  status: "connected" | "needs_reconnect";
  connectedAt: Date;
  syncedAt: Date | null;
} | null; // null = no row at all, i.e. never connected

// Every read/write here is scoped by the session's user_id (AGENTS.md rule 10), matching
// lib/dives.ts's own ownership convention.
export async function getPadiIntegrationStatus(userId: string): Promise<PadiIntegrationStatus> {
  const result = await queryRead<{
    status: string;
    connected_at: Date;
    synced_at: Date | null;
  }>("select status, connected_at, synced_at from padi_integrations where user_id = $1", [userId]);

  const row = result.rows[0];
  if (!row) return null;

  return {
    status: row.status as "connected" | "needs_reconnect",
    connectedAt: row.connected_at,
    syncedAt: row.synced_at,
  };
}

export type SavePadiIntegrationInput = {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresIn: number;
  usernameHash: string;
};

// Called on a successful connect or reconnect. Always resets status to 'connected', clears
// needs_reconnect_at, and bumps connected_at -- the padi_reconnect notification's idempotency key
// (scripts/padi/token-refresh.mjs) derives from needs_reconnect_at, not connected_at, so a later
// disconnect-after-this-reconnect produces a fresh, individually-notifiable key.
export async function savePadiIntegration(userId: string, input: SavePadiIntegrationInput): Promise<void> {
  const key = keyFromEnvValue(process.env.PADI_TOKEN_ENCRYPTION_KEY);

  const accessTokenEncrypted = encryptSecret(input.accessToken, key, `${userId}:access`);
  const refreshTokenEncrypted = encryptSecret(input.refreshToken, key, `${userId}:refresh`);
  const idTokenEncrypted = encryptSecret(input.idToken, key, `${userId}:id`);

  await getPool().query(
    `
      insert into padi_integrations
        (user_id, username_hash, access_token_encrypted, refresh_token_encrypted, id_token_encrypted,
         expires_at, status, needs_reconnect_at, connected_at, updated_at)
      values ($1, $2, $3, $4, $5, now() + ($6 || ' seconds')::interval, 'connected', null, now(), now())
      on conflict (user_id) do update set
        username_hash = excluded.username_hash,
        access_token_encrypted = excluded.access_token_encrypted,
        refresh_token_encrypted = excluded.refresh_token_encrypted,
        id_token_encrypted = excluded.id_token_encrypted,
        expires_at = excluded.expires_at,
        status = 'connected',
        needs_reconnect_at = null,
        connected_at = now(),
        updated_at = now()
    `,
    [userId, input.usernameHash, accessTokenEncrypted, refreshTokenEncrypted, idTokenEncrypted, input.expiresIn],
  );
}

export async function deletePadiIntegration(userId: string): Promise<void> {
  await getPool().query("delete from padi_integrations where user_id = $1", [userId]);
}
