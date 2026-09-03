import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

// Integration test against a real Postgres (helpers/pg.ts's convention: resolve
// TEST_DATABASE_URL ?? DATABASE_URL, fail loudly rather than silently skipping). Covers issue
// #102's new_user_signup notification: countNonTestUsers/isTestUserEmail (lib/users.ts) and the
// enqueue gate in lib/user-signup-notification.ts, including migration
// 014_notification_queue.sql's notification_type constraint actually accepting the type.
import { closeTestPool, getTestPool } from "./helpers/pg";

const { countNonTestUsers } = await import("@/lib/users");
const { notifyNewUserSignup } = await import("@/lib/user-signup-notification");

const originalAdminEmail = process.env.DIVES_ADMIN_EMAIL;

async function insertUser(email: string) {
  await getTestPool().query("insert into users (email, password_hash) values ($1, 'x')", [
    email.toLowerCase(),
  ]);
}

async function queueRowsFor(idempotencyKey: string) {
  const result = await getTestPool().query(
    "select * from notification_queue where idempotency_key = $1",
    [idempotencyKey],
  );
  return result.rows;
}

beforeEach(() => {
  process.env.DIVES_ADMIN_EMAIL = "admin@aleksandr.vin";
});

afterEach(() => {
  if (originalAdminEmail === undefined) delete process.env.DIVES_ADMIN_EMAIL;
  else process.env.DIVES_ADMIN_EMAIL = originalAdminEmail;
});

afterAll(async () => {
  await closeTestPool();
});

describe("countNonTestUsers", () => {
  // The users table is shared across every integration test file running in parallel (same
  // convention as notification-queue.test.mjs), so this can only assert a monotonic lower bound,
  // never an exact delta -- other files' real-looking @example.com signups can also bump the
  // count between the two reads. The exclusion regex itself is exhaustively covered, without any
  // DB or concurrency concerns, by tests/unit/users.test.ts's isTestUserEmail suite.
  it("counts a newly inserted real user (count never decreases, so this is a safe lower bound)", async () => {
    const before = await countNonTestUsers();

    await insertUser(`real-${randomUUID()}@example.com`);

    expect(await countNonTestUsers()).toBeGreaterThanOrEqual(before + 1);
  });
});

describe("notifyNewUserSignup", () => {
  it("enqueues a new_user_signup notification to the admin address for a real signup", async () => {
    const email = `real-${randomUUID()}@example.com`;
    const key = `new-user-signup-${email}`;

    await notifyNewUserSignup({ email });

    const rows = await queueRowsFor(key);
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient_email).toBe("admin@aleksandr.vin");
    expect(rows[0].notification_type).toBe("new_user_signup");
    expect(rows[0].payload.email).toBe(email);
    expect(typeof rows[0].payload.userNumber).toBe("number");
  });

  it("does not enqueue anything for a test.<name>@aleksandr.vin signup", async () => {
    const email = `test.${randomUUID()}@aleksandr.vin`;
    const key = `new-user-signup-${email}`;

    await notifyNewUserSignup({ email });

    expect(await queueRowsFor(key)).toHaveLength(0);
  });

  it("does not enqueue anything for a test.<name>@aleksandr.vin signup", async () => {
    const email = `test.${randomUUID()}@aleksandr.vin`;
    const key = `new-user-signup-${email}`;

    await notifyNewUserSignup({ email });

    expect(await queueRowsFor(key)).toHaveLength(0);
  });

  it("is idempotent per email -- a second call for the same address enqueues no extra row", async () => {
    const email = `real-${randomUUID()}@example.com`;
    const key = `new-user-signup-${email}`;

    await notifyNewUserSignup({ email });
    await notifyNewUserSignup({ email });

    expect(await queueRowsFor(key)).toHaveLength(1);
  });

  it("is a no-op when no admin recipient is configured", async () => {
    delete process.env.DIVES_ADMIN_EMAIL;
    const email = `real-${randomUUID()}@example.com`;
    const key = `new-user-signup-${email}`;

    await notifyNewUserSignup({ email });

    expect(await queueRowsFor(key)).toHaveLength(0);
  });
});
