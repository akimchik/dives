"use server";

import { requireUser } from "@/lib/session";
import { createFeedbackIssue } from "@/lib/gitea/client";
import { logger } from "@/lib/logger";
import { sendPlainEmail } from "@/lib/mailer";
import { withActionTelemetry } from "@/lib/action-otel";

// Same discriminated-union convention as app/actions/padi.ts's PadiActionResult: the button shows
// a spinner and toasts the outcome (AGENTS.md rule 5), so failures come back as a result rather
// than a thrown error.
export type FeedbackActionResult = { ok: true } | { ok: false; error: string };

const MAX_MESSAGE_LENGTH = 5000;
const RATE_LIMIT_MAX_SUBMISSIONS = 3;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const MAX_TITLE_LENGTH = 80;
const UNAVAILABLE_ERROR = "Could not submit feedback right now. Please try again later.";
const RATE_LIMITED_ERROR =
  "You've submitted a lot of feedback recently -- please wait a bit before sending more.";

// Deliberately in-memory rather than a DB table like lib/padi/rate-limit.ts: this is per-process
// and resets on deploy/restart, which is fine for an abuse brake on a low-value endpoint but is
// explicitly not a security boundary.
const recentSubmissions = new Map<string, number[]>();

function isRateLimited(userId: string) {
  const now = Date.now();
  const recent = (recentSubmissions.get(userId) ?? []).filter(
    (at) => now - at < RATE_LIMIT_WINDOW_MS,
  );

  if (recent.length >= RATE_LIMIT_MAX_SUBMISSIONS) {
    recentSubmissions.set(userId, recent);
    return true;
  }

  recent.push(now);
  recentSubmissions.set(userId, recent);
  return false;
}

function buildTitle(message: string) {
  const firstLine = message.split("\n", 1)[0]?.trim() ?? "";
  const title = firstLine.slice(0, MAX_TITLE_LENGTH).trim();

  return title || "User feedback";
}

export async function submitFeedbackAction(message: string): Promise<FeedbackActionResult> {
  const user = await requireUser();

  return withActionTelemetry("submitFeedback", () => user, async () => {
    // Server actions are a public HTTP surface: the argument is whatever the caller posted, not
    // necessarily the string the typed client sends.
    if (typeof message !== "string") {
      return { ok: false, error: "Please enter some feedback before submitting." };
    }

    const trimmed = message.trim();
    if (!trimmed) {
      return { ok: false, error: "Please enter some feedback before submitting." };
    }

    // Checked after validation but before any Gitea/SMTP call, so an empty submission never spends
    // the user's budget and a rejected one never costs an outbound request.
    if (isRateLimited(user.id)) {
      return { ok: false, error: RATE_LIMITED_ERROR };
    }

    // Truncated silently rather than rejected: an over-long message is still useful feedback, it
    // just must not turn into an unbounded Gitea issue body.
    const body = trimmed.slice(0, MAX_MESSAGE_LENGTH);
    const title = buildTitle(body);
    const issueBody = [body, "", "---", `Submitted by: ${user.email}`, `At: ${new Date().toISOString()}`].join("\n");

    let issue: Awaited<ReturnType<typeof createFeedbackIssue>>;
    try {
      issue = await createFeedbackIssue({ title, body: issueBody });
    } catch (error) {
      // The real cause (including any Gitea status) is only ever logged server-side; the client
      // gets a generic message so nothing about the Gitea deployment or its token can leak.
      // pino's error serializer keeps the full Error -- message, stack and the `cause` chain the
      // Gitea client attaches -- so the raw object is what gets logged, not just its message.
      logger.error({ err: error, userId: user.id }, "Failed to create Gitea feedback issue");
      return { ok: false, error: UNAVAILABLE_ERROR };
    }

    // Best effort: the durable record (the issue) already exists, so a mail failure must not turn a
    // successful submission into an error the user is asked to retry.
    try {
      await sendPlainEmail({
        to: process.env.DIVES_ADMIN_EMAIL || "admin@aleksandr.vin",
        subject: `New feedback: ${title}`,
        text: [issueBody, "", `Gitea issue: ${issue.url}`].join("\n"),
      });
    } catch (error) {
      logger.error({ err: error, issueNumber: issue.number }, "Failed to email feedback notification");
    }

    return { ok: true };
  });
}
