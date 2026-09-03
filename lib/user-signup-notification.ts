import "server-only";

import { enqueueNotification } from "./notification-queue";
import { countNonTestUsers, isTestUserEmail } from "./users";

// Growth/monitoring notification. Skips manual QA/staging accounts (see lib/users.ts's isTestUserEmail) so
// admin's inbox reflects real signups only -- both the email itself and the running count it
// reports. Called from both signup paths (password registration and OIDC) since email uniqueness
// on the users table means each address only ever triggers this once, making the idempotency key
// per-email safe.
export async function notifyNewUserSignup(input: { email: string }) {
  if (isTestUserEmail(input.email)) return;

  const recipient = process.env.DIVES_ADMIN_EMAIL?.trim();
  if (!recipient) return;

  const userNumber = await countNonTestUsers();

  await enqueueNotification({
    recipientEmail: recipient,
    notificationType: "new_user_signup",
    idempotencyKey: `new-user-signup-${input.email}`,
    payload: { email: input.email, userNumber },
  });
}
