import pg from "pg";

import { withDbRetry } from "./db-retry.mjs";
import { getDatabaseUrl, loadEnvFiles } from "./env.mjs";
import { createCronjobLogger } from "./ndjson-console.mjs";
import { bootstrapOpenTelemetry, recordCronjobStart, shutdownOpenTelemetry } from "./notifications/otel.mjs";
import { assertKeyConfigured, keyFromEnvValue } from "./padi/crypto.mjs";
import { processPadiTokenRefresh } from "./padi/token-refresh.mjs";

const logger = createCronjobLogger({ service: "padi-token-refresh" });
loadEnvFiles();

// This script's sole job is refreshing PADI tokens, so an unconfigured/placeholder encryption key
// must crash the process immediately, before touching the database -- unlike the app's identical
// check (scripts/padi/crypto.mjs's assertKeyConfigured), which is deliberately lazy because most
// app requests have nothing to do with PADI.
assertKeyConfigured(process.env.PADI_TOKEN_ENCRYPTION_KEY);

bootstrapOpenTelemetry();
recordCronjobStart({ cronjob: "padi-token-refresh" });

const databaseUrl = getDatabaseUrl();

if (!databaseUrl) {
  logger.error("DATABASE_URL is not configured");
  await shutdownOpenTelemetry();
  process.exit(1);
}

const encryptionKey = keyFromEnvValue(process.env.PADI_TOKEN_ENCRYPTION_KEY);
const previousEncryptionKey = process.env.PADI_TOKEN_ENCRYPTION_KEY_PREVIOUS
  ? keyFromEnvValue(process.env.PADI_TOKEN_ENCRYPTION_KEY_PREVIOUS)
  : undefined;

try {
  const summary = await withDbRetry(
    async () => {
      const client = new pg.Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        return await processPadiTokenRefresh(client, { encryptionKey, previousEncryptionKey, logger });
      } finally {
        await client.end();
      }
    },
    { label: "padi-token-refresh", logger },
  );

  logger.info("PADI token refresh processed", summary);
} catch (error) {
  logger.error("PADI token refresh CronJob failed", error);
  process.exitCode = 1;
} finally {
  await shutdownOpenTelemetry();
}
