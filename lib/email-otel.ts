import "server-only";

import { trace, metrics, SpanStatusCode } from "@opentelemetry/api";

const tracer = trace.getTracer("email", "0.1.0");
const meter = metrics.getMeter("email", "0.1.0");

const emailSendCounter = meter.createCounter("email.sends", {
  description: "Number of email send attempts",
});
const emailDurationHistogram = meter.createHistogram("email.duration", {
  description: "Duration of email send operations",
  unit: "ms",
});

export type EmailType = "magic_link";

export async function withEmailTelemetry<T extends { sent: boolean }>(
  emailType: EmailType,
  fn: () => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(`email.send.${emailType}`, async (span) => {
    span.setAttribute("email.type", emailType);
    const start = Date.now();
    let status = "success";
    try {
      const result = await fn();
      if (!result.sent) {
        status = "skipped";
      }
      span.setAttribute("email.sent", result.sent);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      status = "error";
      const msg = err instanceof Error ? err.message : String(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: msg });
      span.recordException(err instanceof Error ? err : new Error(msg));
      throw err;
    } finally {
      emailSendCounter.add(1, { email_type: emailType, status });
      emailDurationHistogram.record(Date.now() - start, { email_type: emailType, status });
      span.end();
    }
  });
}
