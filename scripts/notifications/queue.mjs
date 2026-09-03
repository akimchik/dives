import { sendMail as defaultSendMail } from "../mailer.mjs";
import {
  orderedDiveColumns,
  renderCombinedEmail,
  renderDiveBackupEmail,
  renderNewUserSignupSection,
} from "./templates.mjs";

// Types listed here are combined per recipient into one email (the queue's original behaviour).
// A type left out is sent one row per email: dive_backup opts out because each row carries its own
// per-dive JSON/CSV attachment, which a combined email has no way to represent.
const COMBINABLE_TYPES = new Set(["new_user_signup"]);

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

// Throwing on an unrecognised type is deliberate: an unhandled row used to fall through to an
// empty section list and get marked sent with no email ever leaving. Failing here routes the row
// through recordFailure instead, so it retries and eventually dead-letters visibly.
function buildSections(rows) {
  return rows.map((row) => {
    if (row.notification_type === "new_user_signup") {
      return renderNewUserSignupSection(row.payload);
    }
    throw new Error(`Unsupported combinable notification_type: ${row.notification_type}`);
  });
}

// Groups rows into the units that become one email each: combinable types keep the original
// per-recipient batching, every other row is its own single-row group. First-seen order is
// preserved so the inter-send gap still paces sends the way it did before.
function groupForSending(rows) {
  const groups = [];
  const combinableByRecipient = new Map();

  for (const row of rows) {
    if (!COMBINABLE_TYPES.has(row.notification_type)) {
      groups.push({ recipient: row.recipient_email, rows: [row] });
      continue;
    }

    let group = combinableByRecipient.get(row.recipient_email);
    if (!group) {
      group = { recipient: row.recipient_email, rows: [] };
      combinableByRecipient.set(row.recipient_email, group);
      groups.push(group);
    }
    group.rows.push(row);
  }

  return groups;
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

// The dive_backup email's own payload is the backup: JSON for a faithful round-trip (depth
// profile included), CSV for spreadsheet import. Both are built here, in the send path, because
// the combined-email renderer has no way to carry per-row attachments.
function buildDiveBackupAttachments(payload) {
  const dive = payload?.dive ?? {};
  const columns = orderedDiveColumns(dive);
  const baseName = `dive-${dive.id ?? "unknown"}-${payload?.event ?? "change"}`;

  return [
    {
      filename: `${baseName}.json`,
      contentType: "application/json",
      content: JSON.stringify(payload, null, 2),
    },
    {
      filename: `${baseName}.csv`,
      contentType: "text/csv",
      content:
        `${columns.map(csvCell).join(",")}\n` +
        `${columns.map((column) => csvCell(dive[column])).join(",")}\n`,
    },
  ];
}

// Renders one group into the sendMail arguments. Non-combinable groups always hold exactly one
// row (see groupForSending) and render their own complete email plus attachments; combinable
// groups go through the section/renderCombinedEmail path, which never produces attachments.
function buildMessage(recipient, rows) {
  const [row] = rows;

  if (!COMBINABLE_TYPES.has(row.notification_type)) {
    if (row.notification_type !== "dive_backup") {
      throw new Error(`Unsupported notification_type: ${row.notification_type}`);
    }

    const email = renderDiveBackupEmail(row.payload);
    return {
      to: recipient,
      subject: email.subject,
      html: email.html,
      text: email.text,
      attachments: buildDiveBackupAttachments(row.payload),
    };
  }

  const email = renderCombinedEmail(buildSections(rows));
  return { to: recipient, subject: email.subject, html: email.html, text: email.text };
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

  const groups = groupForSending(claimed);

  let sent = 0;
  let failed = 0;
  let retried = 0;
  let first = true;

  for (const { recipient, rows } of groups) {
    if (!first) await wait(applyJitter(gapMs));
    first = false;

    try {
      // Render inside the try so a single malformed payload dead-letters its own group instead of
      // throwing out of the whole batch and stalling every other recipient.
      const result = await sendMail(buildMessage(recipient, rows));

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
