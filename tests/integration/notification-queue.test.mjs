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

function divePayload(event = "create") {
  return {
    event,
    dive: {
      id: 4321,
      occurred_at: "2026-08-09T07:30:00.000Z",
      site_name: "Blue Hole",
      max_depth: "28.40",
      bottom_time_minutes: 44,
      notes: 'said "wow", twice',
      depth_profile: [{ t: 0, d: 0 }],
    },
  };
}

async function enqueueDiveBackup(recipient, key, event = "create") {
  return enqueueNotification(client, {
    recipientEmail: recipient,
    notificationType: "dive_backup",
    idempotencyKey: key,
    payload: divePayload(event),
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

// dive_backup is the queue's only non-combinable type: each row carries its own per-dive
// attachments, so it must never be folded into a recipient's combined email (plan step 4).
describe("processNotificationQueue dive_backup per-row sends", () => {
  it("sends a dive_backup row on its own while still batching the recipient's combinable rows", async () => {
    const recipient = `mixed-${randomUUID()}@example.com`;
    const signupA = await enqueueSignup(recipient, `mixed-signup-a:${randomUUID()}`);
    const signupB = await enqueueSignup(recipient, `mixed-signup-b:${randomUUID()}`);
    const backupId = await enqueueDiveBackup(recipient, `dive-backup:4321:create:${randomUUID()}`);

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
    expect(mine).toHaveLength(2);

    // (a) Regression: the two new_user_signup rows still collapse into one combined email with no
    // attachments, exactly as before dive_backup existed.
    const combined = mine.filter((message) => message.subject === "Dives: 2 updates");
    expect(combined).toHaveLength(1);
    expect(combined[0].attachments).toBeUndefined();
    expect(combined[0].text).toContain("This is user #7 (excluding test accounts).");

    // (b) The dive_backup row is its own email, carrying the JSON + CSV snapshot.
    const backup = mine.filter((message) => message !== combined[0]);
    expect(backup).toHaveLength(1);
    expect(backup[0].subject).toBe("Dive logged: Blue Hole — 2026-08-09T07:30:00.000Z");
    expect(backup[0].text).toContain("Max depth: 28.40");

    const filenames = backup[0].attachments.map((attachment) => attachment.filename);
    expect(filenames).toEqual(["dive-4321-create.json", "dive-4321-create.csv"]);

    const json = backup[0].attachments.find((a) => a.filename.endsWith(".json"));
    expect(json.contentType).toBe("application/json");
    expect(JSON.parse(json.content)).toEqual(divePayload("create"));

    const csv = backup[0].attachments.find((a) => a.filename.endsWith(".csv"));
    expect(csv.contentType).toBe("text/csv");
    const [header, values] = csv.content.trimEnd().split("\n");
    expect(header).toBe("id,occurred_at,site_name,max_depth,bottom_time_minutes,notes,depth_profile");
    // A comma/quote-bearing free-text field stays in one properly escaped cell...
    const scalarCells = '4321,2026-08-09T07:30:00.000Z,Blue Hole,28.40,44,"said ""wow"", twice",';
    expect(values.startsWith(scalarCells)).toBe(true);
    // ...and so does the depth profile, as embedded JSON. Postgres normalises jsonb key order, so
    // this asserts on the parsed value rather than a byte-exact string.
    const profileCell = values.slice(scalarCells.length);
    expect(JSON.parse(profileCell.slice(1, -1).replaceAll('""', '"'))).toEqual([{ t: 0, d: 0 }]);

    for (const id of [signupA, signupB, backupId]) {
      expect((await statusOf(id)).status).toBe("sent");
    }
  });

  it("never combines two dive_backup rows for the same recipient", async () => {
    const recipient = `two-backups-${randomUUID()}@example.com`;
    const createId = await enqueueDiveBackup(recipient, `dive-backup:4321:create:${randomUUID()}`);
    const editId = await enqueueDiveBackup(recipient, `dive-backup:4321:edit:${randomUUID()}`, "edit");

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
    expect(mine).toHaveLength(2);
    expect(mine.map((message) => message.subject).sort()).toEqual([
      "Dive logged: Blue Hole — 2026-08-09T07:30:00.000Z",
      "Dive updated: Blue Hole — 2026-08-09T07:30:00.000Z",
    ]);
    expect(mine.every((message) => message.attachments.length === 2)).toBe(true);
    expect((await statusOf(createId)).status).toBe("sent");
    expect((await statusOf(editId)).status).toBe("sent");
  });

  it("retries only the failing dive_backup row, leaving the recipient's other rows sent", async () => {
    const recipient = `partial-${randomUUID()}@example.com`;
    const signupId = await enqueueSignup(recipient, `partial-signup:${randomUUID()}`);
    const backupId = await enqueueDiveBackup(recipient, `dive-backup:4321:create:${randomUUID()}`);

    await processNotificationQueue(client, {
      batchSize: 1000,
      sleep: noSleep,
      sendMail: async (message) => {
        if (message.to === recipient && message.attachments) {
          throw Object.assign(new Error("greylisted"), { responseCode: 450 });
        }
        return { sent: true };
      },
    });

    expect((await statusOf(signupId)).status).toBe("sent");
    const backup = await statusOf(backupId);
    expect(backup.status).toBe("pending");
    expect(backup.attempts).toBe(1);
  });
});
