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

// dive_backup is the queue's only notification_type now that new_user_signup was retired (see
// PROMPTLOG.md) -- it doubles as the generic fixture for the claim/retry/batching cases below,
// none of which care what the payload actually contains.
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
    const key = `dive-backup:${randomUUID()}`;

    const firstId = await enqueueDiveBackup(recipient, key);
    const secondId = await enqueueDiveBackup(recipient, key);

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
    const pendingId = await enqueueDiveBackup(recipient, `pending:${randomUUID()}`);
    const sentId = await enqueueDiveBackup(recipient, `sent:${randomUUID()}`);
    const failedId = await enqueueDiveBackup(recipient, `failed:${randomUUID()}`);
    const sendingId = await enqueueDiveBackup(recipient, `sending:${randomUUID()}`);

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
        ids.push(await enqueueDiveBackup(recipient, `race:${randomUUID()}`));
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
    const staleId = await enqueueDiveBackup(recipient, `stale:${randomUUID()}`);
    const freshId = await enqueueDiveBackup(recipient, `fresh:${randomUUID()}`);

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
  it("keeps a row pending with an incremented attempt and future retry on a 4xx failure", async () => {
    const recipient = `retry-${randomUUID()}@example.com`;
    const id = await enqueueDiveBackup(recipient, `retry:${randomUUID()}`);

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
    const id = await enqueueDiveBackup(recipient, `perm:${randomUUID()}`);

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
    const id = await enqueueDiveBackup(recipient, `exhaust:${randomUUID()}`);

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

  it("rejects an unrecognised notification_type instead of silently marking it sent", async () => {
    // Historical rows can still carry the retired new_user_signup type (migration 014's check
    // constraint was left permissive for them, see lib/notification-queue.ts) -- the worker must
    // fail loudly on one, not silently drop it.
    const recipient = `unrecognised-${randomUUID()}@example.com`;
    const id = await enqueueNotification(client, {
      recipientEmail: recipient,
      notificationType: "new_user_signup",
      idempotencyKey: `unrecognised:${randomUUID()}`,
      payload: { email: recipient, userNumber: 1 },
    });

    const calls = [];
    await processNotificationQueue(client, {
      batchSize: 1000,
      // No responseCode on this error, so classifySmtpError treats it as retryable like a network
      // blip (see the "dead-letters a retryable row once attempts reach max_attempts" test above)
      // -- maxAttempts: 1 forces the dead-letter on this first attempt instead of asserting on an
      // intermediate pending/retry state.
      maxAttempts: 1,
      sleep: noSleep,
      sendMail: async (message) => {
        calls.push(message);
        return { sent: true };
      },
    });

    expect(calls.filter((message) => message.to === recipient)).toHaveLength(0);
    const row = await statusOf(id);
    expect(row.status).toBe("failed");
    expect(row.last_error).toContain("Unsupported notification_type: new_user_signup");
  });
});

// dive_backup is the queue's only type, and every row sends as its own email (no combining exists
// any more -- new_user_signup was the only combinable type and was retired, see PROMPTLOG.md).
describe("processNotificationQueue per-row sends", () => {
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

  it("renders the dive_backup email with its JSON + CSV attachments", async () => {
    const recipient = `attachments-${randomUUID()}@example.com`;
    const id = await enqueueDiveBackup(recipient, `dive-backup:4321:create:${randomUUID()}`);

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
    expect(mine[0].subject).toBe("Dive logged: Blue Hole — 2026-08-09T07:30:00.000Z");
    expect(mine[0].text).toContain("Max depth: 28.40");

    const filenames = mine[0].attachments.map((attachment) => attachment.filename);
    expect(filenames).toEqual(["dive-4321-create.json", "dive-4321-create.csv"]);

    const json = mine[0].attachments.find((a) => a.filename.endsWith(".json"));
    expect(json.contentType).toBe("application/json");
    expect(JSON.parse(json.content)).toEqual(divePayload("create"));

    const csv = mine[0].attachments.find((a) => a.filename.endsWith(".csv"));
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

    expect((await statusOf(id)).status).toBe("sent");
  });

  it("retries only the failing row, leaving the recipient's other row sent", async () => {
    const recipient = `partial-${randomUUID()}@example.com`;
    const okId = await enqueueDiveBackup(recipient, `partial-ok:${randomUUID()}`, "create");
    const failingId = await enqueueDiveBackup(recipient, `partial-fail:${randomUUID()}`, "edit");

    await processNotificationQueue(client, {
      batchSize: 1000,
      sleep: noSleep,
      sendMail: async (message) => {
        if (message.to === recipient && message.subject.startsWith("Dive updated")) {
          throw Object.assign(new Error("greylisted"), { responseCode: 450 });
        }
        return { sent: true };
      },
    });

    expect((await statusOf(okId)).status).toBe("sent");
    const failing = await statusOf(failingId);
    expect(failing.status).toBe("pending");
    expect(failing.attempts).toBe(1);
  });
});
