import pg from "pg";

// Integration tests run against a real Postgres (there is no sqlite fallback
// anymore). They resolve the connection from TEST_DATABASE_URL ?? DATABASE_URL
// and fail loudly if neither is set, rather than silently skipping. Tests stay
// collision-safe by generating a fresh random user email per case, so they can
// share one migrated database without truncation or per-test rollback.
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "Integration tests require a real Postgres. Set TEST_DATABASE_URL or DATABASE_URL " +
      "to a migrated database, e.g. " +
      "postgres://dives_user:dives@localhost:5432/dev_dives",
  );
}

// lib/db.ts builds its pool from process.env.DATABASE_URL, so make sure the app
// code under test connects to the same database this helper seeds/peeks.
process.env.DATABASE_URL = databaseUrl;

let pool: pg.Pool | undefined;

export function getTestPool(): pg.Pool {
  if (!pool) pool = new pg.Pool({ connectionString: databaseUrl });
  return pool;
}

export async function closeTestPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
