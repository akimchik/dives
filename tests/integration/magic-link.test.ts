import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

// Integration test for lib/magic-link.ts, run against a real Postgres (helpers/pg.ts
// resolves TEST_DATABASE_URL ?? DATABASE_URL). Each case uses a fresh random email so it
// stays collision-safe against the shared database.
import { closeTestPool, getTestPool } from "./helpers/pg";

const { createMagicLinkToken, consumeMagicLinkToken } = await import("@/lib/magic-link");
const { hashSessionToken } = await import("@/lib/auth/session-token");

afterAll(async () => {
  await closeTestPool();
});

describe("magic-link", () => {
  it("creates a token with a raw value and ~1 hour expiry", async () => {
    const email = `${randomUUID()}@example.com`;
    const before = Date.now();
    const { token, expiresAt } = await createMagicLinkToken(email);
    const after = Date.now();

    expect(token).toBeTruthy();
    expect(typeof token).toBe("string");

    const expiresAtMs = new Date(expiresAt).getTime();
    const oneHourMs = 60 * 60 * 1000;
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + oneHourMs - 5000);
    expect(expiresAtMs).toBeLessThanOrEqual(after + oneHourMs + 5000);
  });

  it("never stores the raw token, only its hash", async () => {
    const email = `${randomUUID()}@example.com`;
    const { token } = await createMagicLinkToken(email);

    const rows = await getTestPool().query<{ token_hash: string }>(
      "select token_hash from magic_link_tokens where email = $1",
      [email],
    );

    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].token_hash).not.toBe(token);
    expect(rows.rows[0].token_hash).toBe(hashSessionToken(token));
  });

  it("consumes a valid token exactly once and rejects reuse", async () => {
    const email = `${randomUUID()}@example.com`;
    const { token } = await createMagicLinkToken(email);

    const first = await consumeMagicLinkToken(token);
    expect(first).toEqual({ email });

    // Token-reuse rejection: the second call with the SAME raw token must fail,
    // proving the `used_at IS NULL` guard in the atomic UPDATE...RETURNING works.
    const second = await consumeMagicLinkToken(token);
    expect(second).toBeNull();
  });

  it("rejects an unknown/invalid token", async () => {
    const result = await consumeMagicLinkToken("this-token-was-never-issued");
    expect(result).toBeNull();
  });

  it("rejects an expired token", async () => {
    const email = `${randomUUID()}@example.com`;
    const { token } = await createMagicLinkToken(email);

    await getTestPool().query(
      "update magic_link_tokens set expires_at = now() - interval '1 hour' where token_hash = $1",
      [hashSessionToken(token)],
    );

    const result = await consumeMagicLinkToken(token);
    expect(result).toBeNull();
  });

  it("resolves two concurrent consumption attempts to exactly one success", async () => {
    const email = `${randomUUID()}@example.com`;
    const { token } = await createMagicLinkToken(email);

    const [a, b] = await Promise.all([consumeMagicLinkToken(token), consumeMagicLinkToken(token)]);
    const successes = [a, b].filter((result) => result !== null);

    expect(successes).toHaveLength(1);
    expect(successes[0]).toEqual({ email });
  });
});
