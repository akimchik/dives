import "server-only";

import type { PoolClient } from "pg";

import { getPool } from "./db";

// Must stay in sync with scripts/notifications/queue.mjs's buildMessage, which only knows how to
// send this type -- migration 014's check constraint still permits the retired "new_user_signup"
// for historical rows, but nothing must ever enqueue one again.
type NotificationType = "dive_backup";

export type EnqueueNotificationInput = {
  recipientEmail: string;
  notificationType: NotificationType;
  idempotencyKey: string;
  payload: unknown;
};

export type EnqueueNotificationOptions = {
  // Lets a caller enqueue inside its own transaction (dive CRUD actions write the dive row and
  // enqueue its dive_backup notification atomically), instead of on a separate pooled connection.
  client?: PoolClient;
};

// Mirrors scripts/notifications/queue.mjs's enqueueNotification. The duplication across the
// TS/.mjs boundary is deliberate: the CronJob worker runs as plain .mjs outside the Next build
// and can't import "@/lib" modules, same reason lib/mailer.ts and scripts/mailer.mjs are twins.
export async function enqueueNotification(
  input: EnqueueNotificationInput,
  options: EnqueueNotificationOptions = {},
): Promise<string | null> {
  const executor = options.client ?? getPool();
  const result = await executor.query<{ id: string }>(
    `
      insert into notification_queue (recipient_email, notification_type, idempotency_key, payload)
      values ($1, $2, $3, $4)
      on conflict (idempotency_key) do nothing
      returning id
    `,
    [input.recipientEmail, input.notificationType, input.idempotencyKey, JSON.stringify(input.payload)],
  );

  return result.rows[0]?.id ?? null;
}
