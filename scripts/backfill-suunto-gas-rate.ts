// One-off backfill: `gasConsumptionRate` (rate(gas_used[1m]), see lib/suunto/profile.ts) was added
// to compileSuuntoDiveProfile after dives/suunto_imports rows already existed, so those rows'
// stored suunto_profile/compiled_profile jsonb predate the field and the chart's "Consumption
// rate" stream stays hidden for them (SuuntoProfileChart.hasValues degrades silently rather than
// erroring). Every row keeps its original SML bundle (dives.suunto_original_bundle,
// suunto_imports.original_bundle -- gzip of `{ files }`, one file being "workout.sml.json"; see
// scripts/suunto-sidecar/server.mjs), so this re-runs the exact current compileSuuntoDiveProfile
// against that same source of truth and overwrites the stored profile with the fresh result.
// Idempotent: safe to re-run, and re-derives the whole profile (not just the new field), so it
// also picks up any other compiler fix made since a row was first imported.
//
// Usage: pnpm suunto:backfill-gas-rate [-- --dry-run]
import pg from "pg";

import { compileSuuntoDiveProfile } from "../lib/suunto/profile";
import { extractSmlJson } from "../lib/suunto/raw-bundle";
import { getDatabaseUrl, loadEnvFiles } from "./env.mjs";

loadEnvFiles();

const databaseUrl = getDatabaseUrl();
if (!databaseUrl) {
  throw new Error("Set DATABASE_URL (and optionally DATABASE_USER/DATABASE_PASSWORD) before running this script.");
}

const dryRun = process.argv.includes("--dry-run");
const pool = new pg.Pool({ connectionString: databaseUrl });

// Bundles that don't decode as the real gzip'd `{ files }` shape (e.g. integration-test fixtures
// sharing this same local database, which write a plain placeholder string as their bundle -- see
// tests/integration/dives.test.ts) should be skipped like any other unrecompilable row, not crash
// the whole run.
function tryRecompile(workoutKey: string, originalBundle: Buffer): ReturnType<typeof compileSuuntoDiveProfile> {
  try {
    return compileSuuntoDiveProfile(workoutKey, extractSmlJson(originalBundle));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function backfillDives(): Promise<{ updated: number; skipped: number }> {
  const { rows } = await pool.query<{
    id: number;
    suunto_workout_key: string;
    suunto_original_bundle: Buffer;
  }>(
    `select id, suunto_workout_key, suunto_original_bundle
     from dives
     where suunto_profile is not null and suunto_original_bundle is not null`,
  );

  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const compiled = tryRecompile(row.suunto_workout_key, row.suunto_original_bundle);
    if (!compiled.ok) {
      console.warn(`dives.id=${row.id}: recompile failed (${compiled.error}), leaving as-is`);
      skipped++;
      continue;
    }

    console.log(`dives.id=${row.id}: ${dryRun ? "would update" : "updating"} suunto_profile`);
    if (!dryRun) {
      await pool.query("update dives set suunto_profile = $2::jsonb where id = $1", [
        row.id,
        JSON.stringify(compiled.profile),
      ]);
    }
    updated++;
  }

  return { updated, skipped };
}

async function backfillPendingImports(): Promise<{ updated: number; skipped: number }> {
  const { rows } = await pool.query<{ id: number; workout_key: string; original_bundle: Buffer }>(
    `select id, workout_key, original_bundle from suunto_imports`,
  );

  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const compiled = tryRecompile(row.workout_key, row.original_bundle);
    if (!compiled.ok) {
      console.warn(`suunto_imports.id=${row.id}: recompile failed (${compiled.error}), leaving as-is`);
      skipped++;
      continue;
    }

    console.log(`suunto_imports.id=${row.id}: ${dryRun ? "would update" : "updating"} compiled_profile`);
    if (!dryRun) {
      await pool.query("update suunto_imports set compiled_profile = $2::jsonb where id = $1", [
        row.id,
        JSON.stringify(compiled.profile),
      ]);
    }
    updated++;
  }

  return { updated, skipped };
}

async function main() {
  const [dives, imports] = await Promise.all([backfillDives(), backfillPendingImports()]);
  console.log(
    `dives: ${dives.updated} updated, ${dives.skipped} skipped. ` +
      `suunto_imports: ${imports.updated} updated, ${imports.skipped} skipped.` +
      (dryRun ? " (dry run, nothing written)" : ""),
  );
  await pool.end();
}

main();
