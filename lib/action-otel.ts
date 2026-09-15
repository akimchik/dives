import "server-only";

import { trace, metrics, SpanStatusCode } from "@opentelemetry/api";

const tracer = trace.getTracer("action", "0.1.0");
const meter = metrics.getMeter("action", "0.1.0");

const actionCounter = meter.createCounter("app.action.calls", {
  description: "Number of server action invocations",
});
const actionDurationHistogram = meter.createHistogram("app.action.duration", {
  description: "Duration of server action invocations",
  unit: "ms",
});

export type ActionTelemetryUser = { id: string; email?: string | null } | null;

type ActionStatus = "success" | "failure" | "redirect" | "error";

// next/navigation's redirect()/notFound()/forbidden()/unauthorized() are control flow, not
// failures: they throw so the App Router can intercept the error, tagged with a `digest` string
// prefix (see node_modules/next/dist/client/components/redirect.js and
// .../http-access-fallback/http-access-fallback.js). withActionTelemetry always rethrows
// unconditionally regardless of this check, so it only affects how the outcome is labeled.
function isFrameworkControlFlowError(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null | undefined)?.digest;
  return (
    typeof digest === "string" &&
    (digest.startsWith("NEXT_REDIRECT") || digest.startsWith("NEXT_HTTP_ERROR_FALLBACK"))
  );
}

// Most actions in app/actions/** already return a `{ ok: boolean }` discriminated union (see e.g.
// DiveActionResult, PadiActionResult) for business-level failures that are reported to the user
// rather than thrown. Surfacing that in the metric (as "failure" rather than "success") is what
// makes the per-action counter actually useful for spotting e.g. a spike in rejected PADI logins.
function resultStatus(result: unknown): "success" | "failure" {
  if (result && typeof result === "object" && "ok" in result) {
    return (result as { ok: unknown }).ok === false ? "failure" : "success";
  }
  return "success";
}

// Issue #26: every action's metrics must be labeled with the session user's email so activity can
// be attributed per-person, falling back to their stable user id if email is somehow unavailable,
// or "anonymous" for actions that ran without (or before) an authenticated session.
// This is a deliberately high-cardinality label (one series per user) -- an explicit product
// requirement here, not the usual metrics hygiene default.
function userLabel(user: ActionTelemetryUser): string {
  if (!user) return "anonymous";
  return user.email || `user:${user.id}`;
}

// Wraps a server action body with a span plus call-count/duration metrics, labeled by action name,
// outcome status, and the invoking user.
//
// `getUser` is a thunk rather than a plain value so actions that don't know the user up front (e.g.
// login, which discovers it mid-flow from submitted credentials) can resolve it lazily: assign a
// `let` variable inside `fn` and read it back via a closure -- by the time this wrapper's `finally`
// runs (after `fn` settles, including via a thrown redirect), the assignment has already happened.
export async function withActionTelemetry<T>(
  actionName: string,
  getUser: () => ActionTelemetryUser,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  let status: ActionStatus = "error";

  return tracer.startActiveSpan(`action.${actionName}`, async (span) => {
    span.setAttribute("action.name", actionName);
    try {
      const result = await fn();
      status = resultStatus(result);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      status = isFrameworkControlFlowError(error) ? "redirect" : "error";
      if (status === "error") {
        const msg = error instanceof Error ? error.message : String(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: msg });
        span.recordException(error instanceof Error ? error : new Error(msg));
      }
      throw error;
    } finally {
      const attributes = { action: actionName, status, user: userLabel(getUser()) };
      actionCounter.add(1, attributes);
      actionDurationHistogram.record(Date.now() - start, attributes);
      span.end();
    }
  });
}
