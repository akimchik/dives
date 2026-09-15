import "server-only";

import { trace, metrics, SpanStatusCode } from "@opentelemetry/api";

const tracer = trace.getTracer("action", "0.1.0");
const meter = metrics.getMeter("action", "0.1.0");

const actionCounter = meter.createCounter("app.action.calls", {
  description: "Number of server action invocations",
});
// Explicit boundaries, not the OTel SDK's default (which tops out at 10s): fetchSuuntoWorkoutsAction
// alone can legitimately run for minutes (see FETCH_ALL_BUDGET_MS in app/actions/suunto.ts), and
// the default's +Inf bucket would otherwise swallow every one of those calls indistinguishably.
const actionDurationHistogram = meter.createHistogram("app.action.duration", {
  description: "Duration of server action invocations",
  unit: "ms",
  advice: { explicitBucketBoundaries: [5, 25, 100, 500, 1000, 2500, 5000, 10000, 30000, 60000, 120000, 300000] },
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

// Most actions in app/actions/** return a `{ ok: boolean }` discriminated union (see e.g.
// DiveActionResult, PadiActionResult) for business-level failures that are reported to the user
// rather than thrown; app/actions/auth.ts's AuthActionState instead uses a truthy `error` string
// for the same purpose. Surfacing either convention in the metric (as "failure" rather than
// "success") is what makes the per-action counter actually useful for spotting e.g. a spike in
// rejected logins or PADI connection attempts.
export function resultStatus(result: unknown): "success" | "failure" {
  if (result && typeof result === "object") {
    if ("ok" in result) {
      return (result as { ok: unknown }).ok === false ? "failure" : "success";
    }
    if ("error" in result && (result as { error: unknown }).error) {
      return "failure";
    }
  }
  return "success";
}

// Issue #26: every action's metrics must be labeled with the session user's email so activity can
// be attributed per-person, falling back to their stable user id if email is somehow unavailable,
// or "anonymous" for actions that ran without (or before) an authenticated session.
// This is a deliberately high-cardinality label (one series per user) -- an explicit product
// requirement here, not the usual metrics hygiene default.
export function userLabel(user: ActionTelemetryUser): string {
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
  // Monotonic, unlike Date.now(): a system clock adjustment mid-request must never turn into a
  // negative duration, and fetchSuuntoWorkoutsAction alone can legitimately run for minutes.
  const start = performance.now();
  let status: ActionStatus = "error";

  return tracer.startActiveSpan(`action.${actionName}`, async (span) => {
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
      // Telemetry emission must never be what decides this action's outcome: a throw from any of
      // these calls would, per JS finally semantics, replace whatever is currently propagating --
      // including a redirect(), which is how login/logout/registration actually complete.
      try {
        const attributes = {
          "action.name": actionName,
          "action.status": status,
          "action.user": userLabel(getUser()),
        };
        span.setAttributes(attributes);
        actionCounter.add(1, attributes);
        actionDurationHistogram.record(performance.now() - start, attributes);
      } catch (telemetryError) {
        console.error("action telemetry failed", telemetryError);
      } finally {
        // Guarded like the block above: span.end() calls SpanProcessor.onEnd synchronously, and a
        // throw from it would otherwise replace whatever is currently propagating (e.g. a redirect).
        try {
          span.end();
        } catch (spanEndError) {
          console.error("action span.end() failed", spanEndError);
        }
      }
    }
  });
}
