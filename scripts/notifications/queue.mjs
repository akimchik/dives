import { sendMail as defaultSendMail } from "../mailer.mjs";
import {
  renderBomUploadedSection,
  renderCombinedEmail,
  renderFirstCheckSection,
  renderNewUserSignupSection,
  renderStatusChangeSection,
  renderTosAcceptanceSection,
} from "./templates.mjs";

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_GAP_MS = 1_500;
const DEFAULT_RETRY_BASE_MS = 2_000;
const DEFAULT_MAX_BACKOFF_MS = 3_600_000;
const DEFAULT_STALE_LOCK_MS = 600_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function applyJitter(ms) {
  return ms * (0.8 + Math.random() * 0.4);
}

export function computeBackoff(attempts, baseMs, maxMs) {
  return Math.min(baseMs * 2 ** attempts, maxMs) * (0.8 + Math.random() * 0.4);
}

export function getNotificationQueueConfig(options = {}) {
  return {
    batchSize: Number(options.batchSize ?? DEFAULT_BATCH_SIZE),
    gapMs: Number(options.gapMs ?? DEFAULT_GAP_MS),
    maxAttempts: options.maxAttempts != null ? Number(options.maxAttempts) : undefined,
    maxBackoffMs: Number(options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS),
    retryBaseMs: Number(options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS),
    staleLockMs: Number(options.staleLockMs ?? DEFAULT_STALE_LOCK_MS),
  };
}

// nodemailer surfaces the SMTP reply code on `.responseCode`; Proton 4xx replies are transient
// (rate/greylisting) and worth retrying, 5xx are permanent rejections, and a missing code means a
// network/timeout error which is also transient.
export function classifySmtpError(error) {
  const code = error?.responseCode;
  if (typeof code === "number") {
    if (code >= 500 && code <= 599) return "permanent";
    if (code >= 400 && code <= 499) return "retryable";
  }
  return "retryable";
}

export async function enqueueNotification(client, { recipientEmail, notificationType, idempotencyKey, payload }) {
  const result = await client.query(
    `
      insert into notification_queue (recipient_email, notification_type, idempotency_key, payload)
      values ($1, $2, $3, $4)
      on conflict (idempotency_key) do nothing
      returning id
    `,
    [recipientEmail, notificationType, idempotencyKey, JSON.stringify(payload)],
  );

  return result.rows[0]?.id ?? null;
}

// Recovers rows a crashed/killed worker left stuck in 'sending'. staleMs is far above any real SMTP
// send, so a row past it is orphaned, not in-flight.
export async function reapStaleLocks(client, staleMs, retryBaseMs) {
  const result = await client.query(
    `
      update notification_queue
      set status = 'pending', locked_at = null,
          next_attempt_at = now() + ($2 || ' milliseconds')::interval
      where status = 'sending' and locked_at < now() - ($1 || ' milliseconds')::interval
      returning id
    `,
    [staleMs, retryBaseMs],
  );

  return result.rowCount;
}

// SKIP LOCKED lets two workers claim disjoint batches in a single round trip without ever handing
// the same row to both, so the queue is safe even without a Forbid concurrency policy.
export async function claimBatch(client, limit) {
  const result = await client.query(
    `
      update notification_queue
      set status = 'sending', locked_at = now()
      where id in (
        select id from notification_queue
        where status = 'pending' and next_attempt_at <= now()
        order by recipient_email, id
        limit $1
        for update skip locked
      )
      returning *
    `,
    [limit],
  );

  return result.rows;
}

function buildSections(rows) {
  const sections = [];
  const statusChangeGroups = new Map();

  for (const row of rows) {
    const payload = row.payload;

    if (row.notification_type === "bom_uploaded") {
      sections.push(renderBomUploadedSection(payload));
    } else if (row.notification_type === "first_check") {
      sections.push(renderFirstCheckSection(payload));
    } else if (row.notification_type === "status_change") {
      // Several item changes on the same file collapse back into one table, matching the
      // pre-queue per-file status-change email.
      const group = statusChangeGroups.get(payload.bomFileId) ?? {
        filename: payload.filename,
        bomFileId: payload.bomFileId,
        baseUrl: payload.baseUrl,
        changes: [],
      };
      group.changes.push(payload.change);
      statusChangeGroups.set(payload.bomFileId, group);
    } else if (row.notification_type === "tos_acceptance") {
      sections.push(renderTosAcceptanceSection(payload));
    } else if (row.notification_type === "new_user_signup") {
      sections.push(renderNewUserSignupSection(payload));
    }
  }

  for (const group of statusChangeGroups.values()) {
    sections.push(renderStatusChangeSection(group));
  }

  return sections;
}

async function markSent(client, rows) {
  const ids = rows.map((row) => row.id);
  await client.query(
    "update notification_queue set status = 'sent', sent_at = now(), locked_at = null where id = any($1::bigint[])",
    [ids],
  );
}

async function resetPending(client, rows) {
  const ids = rows.map((row) => row.id);
  await client.query(
    "update notification_queue set status = 'pending', locked_at = null where id = any($1::bigint[])",
    [ids],
  );
}

async function recordFailure(client, rows, error, classification, { retryBaseMs, maxBackoffMs, maxAttempts }) {
  const message = String(error?.message ?? error).slice(0, 1000);
  let retried = 0;
  let failed = 0;

  await client.query("begin");
  try {
    for (const row of rows) {
      const attempts = row.attempts + 1;
      const limit = maxAttempts ?? row.max_attempts;
      const deadLetter = classification === "permanent" || attempts >= limit;

      if (deadLetter) {
        await client.query(
          "update notification_queue set status = 'failed', attempts = $1, last_error = $2, locked_at = null where id = $3",
          [attempts, message, row.id],
        );
        failed += 1;
      } else {
        const backoff = Math.round(computeBackoff(attempts, retryBaseMs, maxBackoffMs));
        await client.query(
          `
            update notification_queue
            set status = 'pending', attempts = $1, last_error = $2, locked_at = null,
                next_attempt_at = now() + ($3 || ' milliseconds')::interval
            where id = $4
          `,
          [attempts, message, backoff, row.id],
        );
        retried += 1;
      }
    }
    await client.query("commit");
  } catch (dbError) {
    await client.query("rollback");
    throw dbError;
  }

  return { retried, failed };
}

export async function processNotificationQueue(client, options = {}) {
  const { batchSize, gapMs, maxAttempts, maxBackoffMs, retryBaseMs, staleLockMs } =
    getNotificationQueueConfig(options);
  const sendMail = options.sendMail ?? defaultSendMail;
  const wait = options.sleep ?? sleep;

  const reaped = await reapStaleLocks(client, staleLockMs, retryBaseMs);
  const claimed = await claimBatch(client, batchSize);

  const byRecipient = new Map();
  for (const row of claimed) {
    const list = byRecipient.get(row.recipient_email) ?? [];
    list.push(row);
    byRecipient.set(row.recipient_email, list);
  }

  let sent = 0;
  let failed = 0;
  let retried = 0;
  let first = true;

  for (const [recipient, rows] of byRecipient) {
    if (!first) await wait(applyJitter(gapMs));
    first = false;

    try {
      // Render inside the try so a single malformed payload dead-letters its own recipient group
      // instead of throwing out of the whole batch and stalling every other recipient.
      const email = renderCombinedEmail(buildSections(rows));

      const result = await sendMail({
        to: recipient,
        subject: email.subject,
        html: email.html,
        text: email.text,
      });

      if (result?.sent === false) {
        await resetPending(client, rows);
        continue;
      }

      await markSent(client, rows);
      sent += rows.length;
    } catch (error) {
      const classification = classifySmtpError(error);
      const outcome = await recordFailure(client, rows, error, classification, {
        retryBaseMs,
        maxBackoffMs,
        maxAttempts,
      });
      retried += outcome.retried;
      failed += outcome.failed;
    }
  }

  return { processed: claimed.length, sent, failed, retried, reaped };
}
