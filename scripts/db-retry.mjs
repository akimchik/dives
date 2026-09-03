// Postgres error codes seen during a primary failover/promotion: 57P03 while the new primary is
// still starting up, 25006 for the brief window where a promoted replica rejects writes before
// PreventCommandIfReadOnly clears, and the 08xxx connection-exception family / too-many-connections
// for the connection churn around it.
const TRANSIENT_PG_CODES = new Set(["57P03", "25006", "08000", "08001", "08003", "08004", "08006", "53300"]);

const TRANSIENT_NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "EPIPE"]);
const DEFAULT_LOGGER = {
  warn(message, params) {
    if (params === undefined) {
      console.warn(message);
    } else {
      console.warn(message, params);
    }
  },
};

function isTransientDbError(error) {
  if (!error) return false;
  if (TRANSIENT_PG_CODES.has(error.code) || TRANSIENT_NETWORK_CODES.has(error.code)) return true;
  return typeof error.message === "string" && /connection terminated/i.test(error.message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retries transient Postgres failover blips by re-running the whole unit of work with a fresh
// connection. Only safe because callers' DB writes are already idempotent (ON CONFLICT upserts,
// staleness-gated selects, outbox-pattern queue rows) - see scripts/lifecycle-notify.mjs and
// scripts/notifications/queue.mjs.
export async function withDbRetry(
  runOnce,
  { attempts = 4, baseMs = 2000, maxMs = 15000, label = "db operation", logger = DEFAULT_LOGGER } = {},
) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await runOnce();
    } catch (error) {
      if (!isTransientDbError(error) || attempt === attempts) throw error;

      const delay = Math.min(baseMs * 2 ** (attempt - 1), maxMs) * (0.8 + Math.random() * 0.4);
      logger.warn("Transient DB error, retrying", {
        attempt,
        attempts,
        delayMs: Math.round(delay),
        errorMessage: error.message,
        label,
      });
      await sleep(delay);
    }
  }
}
