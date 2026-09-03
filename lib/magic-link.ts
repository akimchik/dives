import "server-only";

import { randomBytes } from "node:crypto";

import { hashSessionToken } from "./auth/session-token";
import { getPool } from "./db";

const magicLinkTtlMs = 60 * 60 * 1000;

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export async function createMagicLinkToken(email: string): Promise<{
  token: string;
  expiresAt: Date;
}> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + magicLinkTtlMs);

  await getPool().query(
    `
      insert into magic_link_tokens (email, token_hash, expires_at)
      values ($1, $2, $3)
    `,
    [normalizeEmail(email), tokenHash, expiresAt],
  );

  return { token, expiresAt };
}

export async function consumeMagicLinkToken(
  rawToken: string,
): Promise<{ email: string } | null> {
  const tokenHash = hashSessionToken(rawToken);

  const result = await getPool().query<{ email: string }>(
    `
      update magic_link_tokens
      set used_at = now()
      where token_hash = $1
        and used_at is null
        and expires_at > now()
      returning email
    `,
    [tokenHash],
  );

  return result.rows[0] ?? null;
}
