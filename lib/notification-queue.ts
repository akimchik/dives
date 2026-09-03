import "server-only";

import { getPool } from "./db";

type NotificationType =
  | "bom_uploaded"
  | "first_check"
  | "status_change"
  | "tos_acceptance"
  | "new_user_signup";

export type EnqueueNotificationInput = {
  recipientEmail: string;
  notificationType: NotificationType;
  idempotencyKey: string;
  payload: unknown;
};

// Mirrors scripts/notifications/queue.mjs's enqueueNotification. The duplication across the
// TS/.mjs boundary is deliberate: the CronJob worker runs as plain .mjs outside the Next build
// and can't import "@/lib" modules, same reason lib/mailer.ts and scripts/mailer.mjs are twins.
export async function enqueueNotification(input: EnqueueNotificationInput): Promise<string | null> {
  const result = await getPool().query<{ id: string }>(
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
