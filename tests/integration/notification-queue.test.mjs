import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import {
  claimBatch,
  enqueueNotification,
  processNotificationQueue,
  reapStaleLocks,
} from "../../scripts/notifications/queue.mjs";

// Integration test against a real Postgres (helpers/pg.ts's convention: resolve
// TEST_DATABASE_URL ?? DATABASE_URL, fail loudly rather than silently skipping). The queue table
// is shared across parallel test files, so every case uses a random recipient/idempotency key and
// asserts only against its own rows (by id or recipient) — never against a global count.
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Integration tests require a real Postgres. Set TEST_DATABASE_URL or DATABASE_URL to a " +
      "migrated database, e.g. postgres://dives_user:dives@localhost:5432/dev_dives",
  );
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

afterAll(async () => {
  await client.end();
});

const noSleep = async () => {};

// new_user_signup is the queue's only combinable type (migration 014's constraint list is
// new_user_signup + dive_backup), so it doubles as the generic fixture for the claim/retry/
// batching cases below -- none of which care which type they carry.
function signupPayload(recipient) {
  return { email: recipient, userNumber: 7 };
}

async function enqueueSignup(recipient, key) {
  return enqueueNotification(client, {
    recipientEmail: recipient,
    notificationType: "new_user_signup",
    idempotencyKey: key,
    payload: signupPayload(recipient),
  });
}

async function statusOf(id) {
  const result = await client.query("select * from notification_queue where id = $1", [id]);
  return result.rows[0];
}

describe("enqueueNotification idempotency", () => {
  it("inserts exactly one row for a repeated idempotency key", async () => {
    const recipient = `dup-${randomUUID()}@example.com`;
    const key = `new_user_signup:${randomUUID()}`;

    const firstId = await enqueueSignup(recipient, key);
    const secondId = await enqueueSignup(recipient, key);

    expect(firstId).not.toBeNull();
    expect(secondId).toBeNull();

    const rows = await client.query(
      "select count(*)::int as count from notification_queue where idempotency_key = $1",
      [key],
    );
    expect(rows.rows[0].count).toBe(1);
  });
});

describe("claimBatch", () => {
  it("marks pending rows sending and excludes sending/sent/failed rows", async () => {
    const recipient = `claim-${randomUUID()}@example.com`;
    const pendingId = await enqueueSignup(recipient, `pending:${randomUUID()}`);
    const sentId = await enqueueSignup(recipient, `sent:${randomUUID()}`);
    const failedId = await enqueueSignup(recipient, `failed:${randomUUID()}`);
    const sendingId = await enqueueSignup(recipient, `sending:${randomUUID()}`);

    await client.query("update notification_queue set status = 'sent' where id = $1", [sentId]);
    await client.query("update notification_queue set status = 'failed' where id = $1", [failedId]);
    await client.query("update notification_queue set status = 'sending', locked_at = now() where id = $1", [
      sendingId,
    ]);

    const claimed = await claimBatch(client, 1000);
    const claimedForRecipient = claimed
      .filter((row) => row.recipient_email === recipient)
      .map((row) => row.id);

    expect(claimedForRecipient).toEqual([pendingId]);
    expect((await statusOf(pendingId)).status).toBe("sending");
  });

  it("never hands the same row to two concurrent claimers", async () => {
    const other = new pg.Client({ connectionString: databaseUrl });
    await other.connect();
    try {
      const recipient = `race-${randomUUID()}@example.com`;
      const ids = [];
      for (let i = 0; i < 6; i += 1) {
        ids.push(await enqueueSignup(recipient, `race:${randomUUID()}`));
      }

      const [batchA, batchB] = await Promise.all([
        claimBatch(client, 1000),
        claimBatch(other, 1000),
      ]);

      const idsA = batchA.filter((row) => row.recipient_email === recipient).map((row) => row.id);
      const idsB = batchB.filter((row) => row.recipient_email === recipient).map((row) => row.id);

      expect(idsA.filter((id) => idsB.includes(id))).toEqual([]);
      expect([...idsA, ...idsB].sort()).toEqual([...ids].sort());
    } finally {
      await other.end();
    }
  });
});

describe("reapStaleLocks", () => {
  it("resets stale sending rows but leaves fresh ones untouched", async () => {
    const recipient = `reap-${randomUUID()}@example.com`;
    const staleId = await enqueueSignup(recipient, `stale:${randomUUID()}`);
    const freshId = await enqueueSignup(recipient, `fresh:${randomUUID()}`);

    await client.query(
      "update notification_queue set status = 'sending', locked_at = now() - interval '20 minutes' where id = $1",
      [staleId],
    );
    await client.query(
      "update notification_queue set status = 'sending', locked_at = now() where id = $1",
      [freshId],
    );

    await reapStaleLocks(client, 600_000, 2_000);

    expect((await statusOf(staleId)).status).toBe("pending");
    expect((await statusOf(freshId)).status).toBe("sending");
  });
});

describe("processNotificationQueue", () => {
  it("collapses two same-recipient rows into one send and marks both sent", async () => {
    const recipient = `combine-${randomUUID()}@example.com`;
    const idA = await enqueueSignup(recipient, `combine-a:${randomUUID()}`);
    const idB = await enqueueSignup(recipient, `combine-b:${randomUUID()}`);

    const calls = [];
    await processNotificationQueue(client, {
      batchSize: 1000,
      sleep: noSleep,
      sendMail: async (message) => {
        calls.push(message);
        return { sent: true };
      },
    });

    const mine = calls.filter((message) => message.to === recipient);
    expect(mine).toHaveLength(1);
    expect((await statusOf(idA)).status).toBe("sent");
    expect((await statusOf(idB)).status).toBe("sent");
  });

  it("keeps a row pending with an incremented attempt and future retry on a 4xx failure", async () => {
    const recipient = `retry-${randomUUID()}@example.com`;
    const id = await enqueueSignup(recipient, `retry:${randomUUID()}`);

    await processNotificationQueue(client, {
      batchSize: 1000,
      sleep: noSleep,
      sendMail: async (message) => {
        if (message.to === recipient) {
          throw Object.assign(new Error("greylisted"), { responseCode: 450 });
        }
        return { sent: true };
      },
    });

    const row = await statusOf(id);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("dead-letters a row immediately on a 5xx failure with no retry", async () => {
    const recipient = `perm-${randomUUID()}@example.com`;
    const id = await enqueueSignup(recipient, `perm:${randomUUID()}`);

    await processNotificationQueue(client, {
      batchSize: 1000,
      sleep: noSleep,
      sendMail: async (message) => {
        if (message.to === recipient) {
          throw Object.assign(new Error("mailbox rejected"), { responseCode: 550 });
        }
        return { sent: true };
      },
    });

    const row = await statusOf(id);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(1);
  });

  it("dead-letters a retryable row once attempts reach max_attempts", async () => {
    const recipient = `exhaust-${randomUUID()}@example.com`;
    const id = await enqueueSignup(recipient, `exhaust:${randomUUID()}`);

    await processNotificationQueue(client, {
      batchSize: 1000,
      maxAttempts: 1,
      sleep: noSleep,
      sendMail: async (message) => {
        if (message.to === recipient) {
          throw Object.assign(new Error("greylisted"), { responseCode: 450 });
        }
        return { sent: true };
      },
    });

    const row = await statusOf(id);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(1);
  });

  // Exercises migration 014's constraint (new_user_signup is an accepted notification_type) and
  // queue.mjs's buildSections wiring for it end-to-end -- see issue #102.
  it("sends a new_user_signup row via renderNewUserSignupSection", async () => {
    const recipient = `admin-${randomUUID()}@example.com`;
    const id = await enqueueNotification(client, {
      recipientEmail: recipient,
      notificationType: "new_user_signup",
      idempotencyKey: `new-user-signup:${randomUUID()}`,
      payload: { email: "new-user@example.com", userNumber: 7 },
    });

    const calls = [];
    await processNotificationQueue(client, {
      batchSize: 1000,
      sleep: noSleep,
      sendMail: async (message) => {
        calls.push(message);
        return { sent: true };
      },
    });

    const mine = calls.filter((message) => message.to === recipient);
    expect(mine).toHaveLength(1);
    expect(mine[0].subject).toBe("New user signup: new-user@example.com");
    expect(mine[0].text).toContain("This is user #7 (excluding test accounts).");
    expect((await statusOf(id)).status).toBe("sent");
  });
});
