import { Pool, type QueryResultRow } from "pg";
import { getDatabaseUrl } from "./database-url";

declare global {
  var divesPgPool: Pool | undefined;
}

export function getPool() {
  if (!globalThis.divesPgPool) {
    const pool = new Pool({
      connectionString: getDatabaseUrl(),
      connectionTimeoutMillis: 3000,
    });

    // Idle pooled clients emit "error" when the server drops them (e.g. a Postgres failover
    // terminating connections); without a listener that's an unhandled error and crashes the process.
    pool.on("error", (error) => {
      console.error("Postgres pool: idle client error", error);
    });

    globalThis.divesPgPool = pool;
  }

  return globalThis.divesPgPool;
}

const TRANSIENT_PG_CODES = new Set(["57P03", "25006", "08000", "08001", "08003", "08004", "08006", "53300"]);
const TRANSIENT_NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "EPIPE"]);

function isTransientDbError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const code = (error as { code?: string }).code;
  if (code && (TRANSIENT_PG_CODES.has(code) || TRANSIENT_NETWORK_CODES.has(code))) return true;

  const message = (error as { message?: string }).message;
  return typeof message === "string" && /connection terminated/i.test(message);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retries a read-only query across a transient Postgres failover (a brief leader-election blip on
// the shared dev-db cluster - see scripts/db-retry.mjs for the same pattern in the CronJob workers).
// Only safe for reads: callers must not pass writes here, since retrying after an ambiguous
// "connection terminated" could otherwise double-apply a write.
export async function queryRead<T extends QueryResultRow>(
  text: string,
  params?: unknown[],
  { attempts = 3, baseMs = 250, maxMs = 2000 }: { attempts?: number; baseMs?: number; maxMs?: number } = {},
) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await getPool().query<T>(text, params);
    } catch (error) {
      if (!isTransientDbError(error) || attempt === attempts) throw error;

      const delay = Math.min(baseMs * 2 ** (attempt - 1), maxMs) * (0.8 + Math.random() * 0.4);
      console.warn(
        `queryRead: transient DB error on attempt ${attempt}/${attempts}, retrying in ${Math.round(delay)}ms: ${(error as Error).message}`,
      );
      await sleep(delay);
    }
  }

  throw new Error("unreachable");
}

export function getDatabaseDriverStatus() {
  return {
    driver: "pg",
    loaded: globalThis.divesPgPool !== undefined,
  };
}
