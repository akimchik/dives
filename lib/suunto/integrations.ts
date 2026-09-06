import "server-only";

import { createHmac } from "node:crypto";

import { getPool, queryRead } from "@/lib/db";
import { decryptSecret, encryptSecret, keyFromEnvValue } from "./crypto";

export type SuuntoIntegrationStatus = {
  status: "connected" | "needs_reconnect";
  connectedAt: Date;
  lastFetchAt: Date | null;
  needsReconnectAt: Date | null;
} | null;

export type SaveSuuntoIntegrationInput = {
  email: string;
  sessionJson: string;
};

const SUUNTO_PEPPER_PLACEHOLDER = "replace-with-suunto-email-hash-pepper";
const PADI_PEPPER_PLACEHOLDER = "replace-with-padi-username-hash-pepper";

function configuredSessionKey(): Buffer {
  return keyFromEnvValue(
    process.env.SUUNTO_SESSION_ENCRYPTION_KEY ?? process.env.PADI_TOKEN_ENCRYPTION_KEY,
  );
}

function previousSessionKey(): Buffer | undefined {
  const value = process.env.SUUNTO_SESSION_ENCRYPTION_KEY_PREVIOUS ?? process.env.PADI_TOKEN_ENCRYPTION_KEY_PREVIOUS;
  return value ? keyFromEnvValue(value) : undefined;
}

function emailHashKey(): string {
  const pepper = process.env.SUUNTO_EMAIL_HASH_PEPPER ?? process.env.PADI_USERNAME_HASH_PEPPER;
  if (!pepper || pepper === SUUNTO_PEPPER_PLACEHOLDER || pepper === PADI_PEPPER_PLACEHOLDER) {
    throw new Error("SUUNTO_EMAIL_HASH_PEPPER is not configured");
  }
  return pepper;
}

export function hashSuuntoEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  return createHmac("sha256", emailHashKey()).update(normalized).digest("hex");
}

export function assertSuuntoIntegrationConfigured(): void {
  configuredSessionKey();
  emailHashKey();
}

export async function getSuuntoIntegrationStatus(userId: string): Promise<SuuntoIntegrationStatus> {
  const result = await queryRead<{
    status: string;
    connected_at: Date;
    last_fetch_at: Date | null;
    needs_reconnect_at: Date | null;
  }>(
    `
      select status, connected_at, last_fetch_at, needs_reconnect_at
      from suunto_integrations
      where user_id = $1
    `,
    [userId],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    status: row.status as "connected" | "needs_reconnect",
    connectedAt: row.connected_at,
    lastFetchAt: row.last_fetch_at,
    needsReconnectAt: row.needs_reconnect_at,
  };
}

export async function saveSuuntoIntegration(
  userId: string,
  input: SaveSuuntoIntegrationInput,
): Promise<void> {
  const key = configuredSessionKey();
  const sessionEncrypted = encryptSecret(input.sessionJson, key, `${userId}:suunto:session`);

  await getPool().query(
    `
      insert into suunto_integrations
        (user_id, email_hash, session_encrypted, status, needs_reconnect_at, connected_at, updated_at)
      values ($1, $2, $3, 'connected', null, now(), now())
      on conflict (user_id) do update set
        email_hash = excluded.email_hash,
        session_encrypted = excluded.session_encrypted,
        status = 'connected',
        needs_reconnect_at = null,
        connected_at = now(),
        updated_at = now()
    `,
    [userId, hashSuuntoEmail(input.email), sessionEncrypted],
  );
}

export async function getSuuntoSessionJson(userId: string): Promise<string | null> {
  const result = await queryRead<{ session_encrypted: string }>(
    "select session_encrypted from suunto_integrations where user_id = $1 and status = 'connected'",
    [userId],
  );
  const ciphertext = result.rows[0]?.session_encrypted;
  if (!ciphertext) return null;

  return decryptSecret(ciphertext, configuredSessionKey(), `${userId}:suunto:session`, previousSessionKey());
}

export async function markSuuntoFetched(userId: string): Promise<void> {
  await getPool().query(
    "update suunto_integrations set last_fetch_at = now(), updated_at = now() where user_id = $1",
    [userId],
  );
}

export async function markSuuntoNeedsReconnect(userId: string): Promise<void> {
  await getPool().query(
    `
      update suunto_integrations
      set status = 'needs_reconnect', needs_reconnect_at = coalesce(needs_reconnect_at, now()), updated_at = now()
      where user_id = $1
    `,
    [userId],
  );
}

export async function deleteSuuntoIntegration(userId: string): Promise<void> {
  await getPool().query("delete from suunto_integrations where user_id = $1", [userId]);
}
