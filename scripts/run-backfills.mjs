// Generic runner for every backfill under scripts/backfills/. Runs on every deploy as a Deployment
// initContainer (see helm-charts/templates/deployment.yaml's "backfills" initContainer, which runs
// after the schema-migration initContainer and before the app container starts) -- the same "blocks
// the rollout until it finishes" mechanism migrations already use, gated by CI's `kubectl rollout
// status` step rather than a `helm upgrade --wait` flag (see .gitea/workflows/deploy.yml).
//
// Because this reruns on *every* future deploy forever, not just once, every module under
// scripts/backfills/ MUST be idempotent (cheap, safe no-op after its real work is done) -- that's
// the whole point of not needing a one-shot Job with a manual enable flag per backfill.
//
// Contract for a new backfill: add a `*.mjs` file directly under scripts/backfills/ (not nested)
// exporting `export default async function backfill(pool, { dryRun })`. It receives this runner's
// shared pg Pool and should log its own progress via console.log/warn; its return value is ignored.
// Modules run in filename order, sequentially (not parallel) -- a later backfill may depend on data
// an earlier one produced, and sequencing keeps log output readable. Keep each backfill
// self-contained (no importing from lib/): the Docker image's runner stage copies scripts/ and
// migrations/ verbatim but not lib/, the same constraint every other Postgres-talking script here
// (db-migrate.mjs, notification-worker.mjs) already works around. A backfill that genuinely needs
// non-trivial logic already living in lib/ (e.g. scripts/backfill-suunto-gas-rate.ts, which needs
// lib/suunto/profile.ts's SML compiler) is a local-only `pnpm <script>` run against a reachable
// DATABASE_URL instead -- this harness is for backfills simple enough to duplicate as plain SQL/JS.
//
// Usage: pnpm backfills:run [-- --dry-run]
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { getDatabaseUrl, loadEnvFiles } from "./env.mjs";

loadEnvFiles();

const databaseUrl = getDatabaseUrl();
if (!databaseUrl) {
  throw new Error("Set DATABASE_URL (and optionally DATABASE_USER/DATABASE_PASSWORD) before running backfills.");
}

const dryRun = process.argv.includes("--dry-run");
const pool = new pg.Pool({ connectionString: databaseUrl });

const backfillsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "backfills");
const files = readdirSync(backfillsDir)
  .filter((file) => file.endsWith(".mjs"))
  .sort();

async function main() {
  for (const file of files) {
    console.log(`--- backfill: ${file}${dryRun ? " (dry run)" : ""} ---`);
    const { default: backfill } = await import(path.join(backfillsDir, file));
    await backfill(pool, { dryRun });
  }
  await pool.end();
}

main();
