import { randomBytes, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { encryptSecret, decryptSecret } from "../../scripts/padi/crypto.mjs";
import { PadiApiError } from "../../scripts/padi/client.mjs";
import { processPadiTokenRefresh } from "../../scripts/padi/token-refresh.mjs";

// Integration test against a real Postgres (helpers/pg.ts's convention: resolve
// TEST_DATABASE_URL ?? DATABASE_URL, fail loudly rather than silently skipping). Each case uses a
// fresh random user, so this file is safe to run alongside the other integration files that share
// the same notification_queue / padi_integrations tables.
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Integration tests require a real Postgres. Set TEST_DATABASE_URL or DATABASE_URL to a " +
      "migrated database, e.g. postgres://dives_user:dives@localhost:5432/dev_dives",
  );
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

// processPadiTokenRefresh's "due" query is global (status='connected' and expires_at < ...), and
// every fixture row this file creates uses expires_at = now() - interval '5 minutes' (permanently
// due -- it never ages out of the window on its own, unlike a real token's ~1-hour expiry). Without
// a purge, every row from every past run of this file (across every `pnpm test:pg` invocation, not
// just within one process) stays "due" forever and gets swept into every future run's due-set,
// inflating decryptFailures counts and eventually tripping the circuit breaker on runs that never
// intentionally created a decrypt failure at all. Purge before and after, same pattern as
// tests/integration/padi-sync.test.ts.
async function purgeOwnUsers() {
  await client.query("delete from users where email like 'padi-refresh-%@example.com'");
}

beforeAll(async () => {
  await purgeOwnUsers();
});

// Also purge between individual tests, not just before/after the whole file: a row whose outcome
// is decryptFailure or refreshFailure never has its status or expires_at changed, so -- unlike a
// "refreshed" row (expires_at pushed ~1hr out) or a "needsReconnect" row (status leaves
// 'connected') -- it stays "due" forever and would otherwise get swept into every later test's
// due-set within this same file run, not just future runs of the file.
afterEach(async () => {
  await purgeOwnUsers();
});

afterAll(async () => {
  await client.end();
});

const encryptionKey = randomBytes(32);

async function createUser() {
  const email = `padi-refresh-${randomUUID()}@example.com`;
  const result = await client.query("insert into users (email, password_hash) values ($1, 'x') returning id", [
    email,
  ]);
  return { id: result.rows[0].id, email };
}

function encryptField(userId, field, plaintext) {
  return encryptSecret(plaintext, encryptionKey, `${userId}:${field}`);
}

function decryptField(userId, field, ciphertext) {
  return decryptSecret(ciphertext, encryptionKey, `${userId}:${field}`);
}

// Inserts a padi_integrations row that's already due for refresh (expires_at in the past).
async function insertDueIntegration(userId, { refreshToken = "refresh-token", idToken = "id-token" } = {}) {
  await client.query(
    `
      insert into padi_integrations
        (user_id, username_hash, access_token_encrypted, refresh_token_encrypted, id_token_encrypted, expires_at, status)
      values ($1, $2, $3, $4, $5, now() - interval '5 minutes', 'connected')
    `,
    [
      userId,
      `hash-${randomUUID()}`,
      encryptField(userId, "access", "access-token"),
      encryptField(userId, "refresh", refreshToken),
      encryptField(userId, "id", idToken),
    ],
  );
}

async function integrationOf(userId) {
  const result = await client.query("select * from padi_integrations where user_id = $1", [userId]);
  return result.rows[0];
}

async function reconnectRowsOf(email) {
  const result = await client.query(
    "select * from notification_queue where recipient_email = $1 and notification_type = 'padi_reconnect' order by id",
    [email],
  );
  return result.rows;
}

describe("processPadiTokenRefresh", () => {
  it("refreshes a due token and re-encrypts the row's columns", async () => {
    const user = await createUser();
    await insertDueIntegration(user.id);
    const before = await integrationOf(user.id);

    const result = await processPadiTokenRefresh(client, {
      encryptionKey,
      refreshFn: async () => ({
        tokens: {
          accessToken: "new-access-token",
          refreshToken: "new-refresh-token",
          idToken: "new-id-token",
          expiresIn: 3600,
        },
      }),
    });

    expect(result.refreshed).toBe(1);
    expect(result.needsReconnect).toBe(0);
    expect(result.decryptFailures).toBe(0);

    const after = await integrationOf(user.id);
    expect(after.status).toBe("connected");
    expect(after.needs_reconnect_at).toBeNull();
    expect(after.access_token_encrypted).not.toBe(before.access_token_encrypted);
    expect(decryptField(user.id, "access", after.access_token_encrypted)).toBe("new-access-token");
    expect(decryptField(user.id, "refresh", after.refresh_token_encrypted)).toBe("new-refresh-token");
    expect(decryptField(user.id, "id", after.id_token_encrypted)).toBe("new-id-token");
    expect(new Date(after.expires_at).getTime()).toBeGreaterThan(Date.now() + 3_000_000);
  });

  it("accepts a flat token set from the refresh endpoint", async () => {
    const user = await createUser();
    await insertDueIntegration(user.id);

    const result = await processPadiTokenRefresh(client, {
      encryptionKey,
      refreshFn: async () => ({
        accessToken: "flat-access-token",
        refreshToken: "flat-refresh-token",
        idToken: "flat-id-token",
        expiresIn: "3600",
      }),
    });

    expect(result.refreshed).toBe(1);
    expect(result.needsReconnect).toBe(0);
    expect(result.refreshFailures).toBe(0);

    const after = await integrationOf(user.id);
    expect(after.status).toBe("connected");
    expect(decryptField(user.id, "access", after.access_token_encrypted)).toBe("flat-access-token");
    expect(decryptField(user.id, "refresh", after.refresh_token_encrypted)).toBe("flat-refresh-token");
    expect(decryptField(user.id, "id", after.id_token_encrypted)).toBe("flat-id-token");
  });

  it("sets needs_reconnect and enqueues exactly one padi_reconnect row on a rejected refresh", async () => {
    const user = await createUser();
    await insertDueIntegration(user.id);

    const result = await processPadiTokenRefresh(client, {
      encryptionKey,
      refreshFn: async () => {
        throw new PadiApiError("PADI request failed with status 401", 401);
      },
    });

    expect(result.refreshed).toBe(0);
    expect(result.needsReconnect).toBe(1);

    const after = await integrationOf(user.id);
    expect(after.status).toBe("needs_reconnect");
    expect(after.needs_reconnect_at).not.toBeNull();

    const rows = await reconnectRowsOf(user.email);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toEqual({ userId: user.id });
    expect(rows[0].idempotency_key).toBe(
      `padi-reconnect:${user.id}:${new Date(after.needs_reconnect_at).toISOString()}`,
    );
  });

  // The direct regression test for the bug this design exists to prevent: a second disconnect
  // event, after a successful reconnect, must produce a fresh notification rather than being
  // silently suppressed by the first disconnect's idempotency key.
  it("enqueues a second, distinct notification after a reconnect followed by another disconnect", async () => {
    const user = await createUser();
    await insertDueIntegration(user.id);

    await processPadiTokenRefresh(client, {
      encryptionKey,
      refreshFn: async () => {
        throw new PadiApiError("PADI request failed with status 401", 401);
      },
    });

    const firstRows = await reconnectRowsOf(user.email);
    expect(firstRows).toHaveLength(1);

    // Simulate a successful reconnect: back to 'connected', needs_reconnect_at cleared, and a
    // fresh due integration (as the real connect action would leave it).
    await client.query(
      `
        update padi_integrations
        set status = 'connected', needs_reconnect_at = null, connected_at = now(),
            access_token_encrypted = $2, refresh_token_encrypted = $3, id_token_encrypted = $4,
            expires_at = now() - interval '5 minutes', updated_at = now()
        where user_id = $1
      `,
      [
        user.id,
        encryptField(user.id, "access", "reconnected-access-token"),
        encryptField(user.id, "refresh", "reconnected-refresh-token"),
        encryptField(user.id, "id", "reconnected-id-token"),
      ],
    );

    // Second disconnect event.
    await processPadiTokenRefresh(client, {
      encryptionKey,
      refreshFn: async () => {
        throw new PadiApiError("PADI request failed with status 401", 401);
      },
    });

    const secondRows = await reconnectRowsOf(user.email);
    expect(secondRows).toHaveLength(2);
    expect(secondRows[1].idempotency_key).not.toBe(firstRows[0].idempotency_key);
  });

  it("classifies decrypt failures as infrastructure errors and never flips status", async () => {
    const user = await createUser();
    const wrongKey = randomBytes(32);
    // Encrypted under a different key than the one processPadiTokenRefresh is given, so decryption
    // fails the same way a misconfigured PADI_TOKEN_ENCRYPTION_KEY would.
    await client.query(
      `
        insert into padi_integrations
          (user_id, username_hash, access_token_encrypted, refresh_token_encrypted, id_token_encrypted, expires_at, status)
        values ($1, $2, $3, $4, $5, now() - interval '5 minutes', 'connected')
      `,
      [
        user.id,
        `hash-${randomUUID()}`,
        encryptSecret("access-token", wrongKey, `${user.id}:access`),
        encryptSecret("refresh-token", wrongKey, `${user.id}:refresh`),
        encryptSecret("id-token", wrongKey, `${user.id}:id`),
      ],
    );

    const result = await processPadiTokenRefresh(client, {
      encryptionKey,
      refreshFn: async () => {
        throw new Error("should never be called for a row that fails to decrypt");
      },
    });

    expect(result.decryptFailures).toBe(1);
    expect(result.needsReconnect).toBe(0);

    const after = await integrationOf(user.id);
    expect(after.status).toBe("connected");
    expect(after.needs_reconnect_at).toBeNull();
    expect(await reconnectRowsOf(user.email)).toHaveLength(0);
  });

  it("treats a 2xx refresh-token rejection body as needs_reconnect instead of throwing", async () => {
    const user = await createUser();
    await insertDueIntegration(user.id);

    const result = await processPadiTokenRefresh(client, {
      encryptionKey,
      refreshFn: async () => ({ message: "Refresh token expired" }),
    });

    expect(result.refreshed).toBe(0);
    expect(result.needsReconnect).toBe(1);
    expect(result.refreshFailures).toBe(0);

    const after = await integrationOf(user.id);
    expect(after.status).toBe("needs_reconnect");
    expect(after.needs_reconnect_at).not.toBeNull();
    expect(await reconnectRowsOf(user.email)).toHaveLength(1);
  });

  it("classifies a malformed successful refresh body as transient instead of crashing the cronjob", async () => {
    const user = await createUser();
    await insertDueIntegration(user.id);

    const result = await processPadiTokenRefresh(client, {
      encryptionKey,
      refreshFn: async () => ({ message: "temporarily unavailable" }),
    });

    expect(result.refreshed).toBe(0);
    expect(result.needsReconnect).toBe(0);
    expect(result.refreshFailures).toBe(1);

    const after = await integrationOf(user.id);
    expect(after.status).toBe("connected");
    expect(after.needs_reconnect_at).toBeNull();
    expect(await reconnectRowsOf(user.email)).toHaveLength(0);
  });

  // Direct regression test for the mass-disconnect bug found during review: scripts/padi/client.mjs
  // turns EVERY failed fetch into a PadiApiError, including network errors and non-401 statuses (a
  // 503, a DNS blip) -- only a genuine 401 means PADI actually rejected the refresh token. Treating
  // any PadiApiError as "needs reconnect" would mass-disconnect and mass-email every connected user
  // on a single PADI outage, since the due-query on a ~1-hour token / 30-minute schedule typically
  // selects everyone in one run.
  it("classifies a non-401 PADI error as a transient refresh failure, not a token rejection", async () => {
    const user = await createUser();
    await insertDueIntegration(user.id);

    const result = await processPadiTokenRefresh(client, {
      encryptionKey,
      refreshFn: async () => {
        throw new PadiApiError("PADI request failed with status 503", 503);
      },
    });

    expect(result.needsReconnect).toBe(0);
    expect(result.refreshFailures).toBe(1);

    const after = await integrationOf(user.id);
    expect(after.status).toBe("connected");
    expect(after.needs_reconnect_at).toBeNull();
    expect(await reconnectRowsOf(user.email)).toHaveLength(0);
  });

  it("classifies a network error (no HTTP status at all) the same way -- also not a token rejection", async () => {
    const user = await createUser();
    await insertDueIntegration(user.id);

    const result = await processPadiTokenRefresh(client, {
      encryptionKey,
      refreshFn: async () => {
        throw new PadiApiError("PADI request failed: network error", undefined);
      },
    });

    expect(result.needsReconnect).toBe(0);
    expect(result.refreshFailures).toBe(1);

    const after = await integrationOf(user.id);
    expect(after.status).toBe("connected");
    expect(await reconnectRowsOf(user.email)).toHaveLength(0);
  });

  it("aborts the whole run once decrypt failures exceed the circuit-breaker threshold, without processing rows past the trip point", async () => {
    const wrongKey = randomBytes(32);
    const users = [];
    for (let i = 0; i < 4; i += 1) {
      const user = await createUser();
      users.push(user);
      await client.query(
        `
          insert into padi_integrations
            (user_id, username_hash, access_token_encrypted, refresh_token_encrypted, id_token_encrypted, expires_at, status)
          values ($1, $2, $3, $4, $5, now() - interval '5 minutes', 'connected')
        `,
        [
          user.id,
          `hash-${randomUUID()}`,
          encryptSecret("access-token", wrongKey, `${user.id}:access`),
          encryptSecret("refresh-token", wrongKey, `${user.id}:refresh`),
          encryptSecret("id-token", wrongKey, `${user.id}:id`),
        ],
      );
    }

    // A 5th row, decryptable and due, created AFTER the 4 wrongKey ones -- createUser()'s serial id
    // sorts it after them under the due query's `order by pi.user_id asc`. This is what actually
    // distinguishes the in-loop breaker (stops before ever reaching this row) from the old
    // post-loop check (would have processed all 5, calling refreshFn for this one) -- without it,
    // every assertion below would pass identically under either implementation.
    const survivor = await createUser();
    await insertDueIntegration(survivor.id);
    let refreshCalls = 0;

    await expect(
      processPadiTokenRefresh(client, {
        encryptionKey,
        decryptFailureThreshold: 3,
        refreshFn: async () => {
          refreshCalls += 1;
          throw new Error("should never be called");
        },
      }),
    ).rejects.toThrow(/possible.*misconfiguration/i);

    expect(refreshCalls).toBe(0);

    for (const user of users) {
      const row = await integrationOf(user.id);
      expect(row.status).toBe("connected");
      expect(row.needs_reconnect_at).toBeNull();
    }

    // The survivor was never reached -- still due, untouched.
    const survivorRow = await integrationOf(survivor.id);
    expect(survivorRow.status).toBe("connected");
    expect(new Date(survivorRow.expires_at).getTime()).toBeLessThan(Date.now());
  });
});
