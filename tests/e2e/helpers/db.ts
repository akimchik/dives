import { randomBytes } from "node:crypto";

import pg from "pg";

// e2e-only helper: connects to the SAME Postgres the `pnpm dev` server (spawned by
// playwright.config.ts's webServer with DATABASE_URL) uses, so tests can seed state the UI
// has no way to trigger deterministically (e.g. a magic-link token, since the real email is
// never sent in dev/test — mailer is unconfigured).
//
// Deliberately uses a raw pg pool + a relative import of lib/auth/session-token.ts instead
// of importing lib/magic-link.ts or lib/session.ts directly: those modules (and most of
// lib/) start with `import "server-only"`, which throws when loaded outside a Next.js RSC
// bundle — including in Playwright's plain Node test process. session-token.ts has no such
// import, so it's safe to reuse here for hash-compatibility with the server.
import { hashSessionToken } from "../../../lib/auth/session-token";
// getDatabaseUrl merges the split DATABASE_USER/DATABASE_PASSWORD convention (used by CI and
// scripts/db-migrate.mjs) into DATABASE_URL -- a raw process.env.DATABASE_URL read here would
// miss those and connect as the wrong role wherever the URL itself doesn't embed credentials.
import { getDatabaseUrl } from "../../../scripts/env.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL ?? getDatabaseUrl();

if (!databaseUrl) {
  throw new Error(
    "e2e tests require a real Postgres. Set TEST_DATABASE_URL or DATABASE_URL to a migrated " +
      "database, e.g. postgres://dives_user:dives@localhost:5432/dev_dives",
  );
}

// allowExitOnIdle so the pool never keeps the Playwright test process alive after the run.
const pool = new pg.Pool({ connectionString: databaseUrl, allowExitOnIdle: true });

/**
 * Inserts a valid, unused magic-link token row directly into magic_link_tokens and returns
 * the raw token, exactly as createMagicLinkToken(email) would hand back to a caller for use
 * in a `/register/[token]` URL.
 */
export async function seedMagicLinkToken(email: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

  await pool.query(
    "insert into magic_link_tokens (email, token_hash, expires_at) values ($1, $2, $3)",
    [email, tokenHash, expiresAt],
  );

  return token;
}

export function uniqueTestEmail(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString("hex")}@example.com`;
}
