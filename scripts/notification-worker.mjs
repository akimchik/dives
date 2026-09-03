import pg from "pg";
import { getDatabaseUrl, loadEnvFiles } from "./env.mjs";
import { createCronjobLogger } from "./ndjson-console.mjs";
import { bootstrapOpenTelemetry, recordCronjobStart, shutdownOpenTelemetry } from "./notifications/otel.mjs";
import { getNotificationQueueConfig, processNotificationQueue } from "./notifications/queue.mjs";
import { withDbRetry } from "./db-retry.mjs";

const logger = createCronjobLogger({ service: "notification-worker" });
loadEnvFiles();
bootstrapOpenTelemetry();
const queueConfig = getNotificationQueueConfig({
  batchSize: process.env.NOTIFICATIONS_BATCH_SIZE,
  gapMs: process.env.NOTIFICATIONS_GAP_MS,
  retryBaseMs: process.env.NOTIFICATIONS_RETRY_BASE_MS,
  maxBackoffMs: process.env.NOTIFICATIONS_MAX_BACKOFF_MS,
  staleLockMs: process.env.NOTIFICATIONS_STALE_LOCK_MS,
  maxAttempts: process.env.NOTIFICATIONS_MAX_ATTEMPTS,
});
recordCronjobStart({
  batch_size: queueConfig.batchSize,
  cronjob: "notification-worker",
  gap_ms: queueConfig.gapMs,
  max_attempts: queueConfig.maxAttempts ?? "queue_default",
  max_backoff_ms: queueConfig.maxBackoffMs,
  retry_base_ms: queueConfig.retryBaseMs,
  stale_lock_ms: queueConfig.staleLockMs,
});

const databaseUrl = getDatabaseUrl();

if (!databaseUrl) {
  logger.error("DATABASE_URL is not configured");
  await shutdownOpenTelemetry();
  process.exit(1);
}

try {
  const result = await withDbRetry(
    async () => {
      const client = new pg.Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        return await processNotificationQueue(client, {
          batchSize: process.env.NOTIFICATIONS_BATCH_SIZE,
          gapMs: process.env.NOTIFICATIONS_GAP_MS,
          retryBaseMs: process.env.NOTIFICATIONS_RETRY_BASE_MS,
          maxBackoffMs: process.env.NOTIFICATIONS_MAX_BACKOFF_MS,
          staleLockMs: process.env.NOTIFICATIONS_STALE_LOCK_MS,
          maxAttempts: process.env.NOTIFICATIONS_MAX_ATTEMPTS,
        });
      } finally {
        await client.end();
      }
    },
    { label: "notification-worker", logger },
  );

  logger.info("Notification queue processed", {
    failed: result.failed,
    processed: result.processed,
    reaped: result.reaped,
    retried: result.retried,
    sent: result.sent,
  });
} catch (error) {
  logger.error("Notification worker CronJob failed", error);
  process.exitCode = 1;
} finally {
  await shutdownOpenTelemetry();
}
