// One-off backfill for issue #20: before this fix, PADI import stored PADI's own enum codes
// (e.g. "SmallWaves", "SomeCurrent", "FullSuit_7mm") verbatim in dives.waves/current/surge/
// suit_type/weight_feedback instead of translating them to this app's own vocabulary (see
// lib/padi/field-map.ts / lib/padi/enum-map.ts). Fixing the mapper only changes what happens on the
// *next* import -- it doesn't touch rows already in the table, and re-running "Sync from PADI"
// doesn't help either (lib/padi/sync.ts only inserts new dives, dedup'd by padi_dive_id; it never
// rewrites an already-imported one). This script re-applies the current reverse maps to every
// PADI-imported dive still holding a raw PADI code.
//
// Only rewrites a column when its current value is a *recognized* PADI code (a key in the reverse
// map) -- i.e. a value this fix now knows how to translate. A column already holding an app-format
// value, or a genuinely unrecognized future PADI code with no map entry either direction, is left
// untouched (the latter keeps showing the dive-form's "unrecognized value" warning, which is the
// intended fallback UX for issue #20, not a bug this script should paper over).
//
// Idempotent: a column already in app format has no matching reverse-map key, so a second run is a
// no-op.
//
// Usage: pnpm padi:backfill-enums [-- --dry-run]
import pg from "pg";

import {
  APP_CURRENT_BY_PADI_CURRENT,
  APP_SUIT_BY_PADI_SUIT,
  APP_SURGE_BY_PADI_SURGE,
  APP_WAVES_BY_PADI_WAVES,
  APP_WEIGHT_BY_PADI_WEIGHT,
} from "../lib/padi/enum-map";
import { getDatabaseUrl, loadEnvFiles } from "./env.mjs";

loadEnvFiles();

const databaseUrl = getDatabaseUrl();
if (!databaseUrl) {
  throw new Error("Set DATABASE_URL (and optionally DATABASE_USER/DATABASE_PASSWORD) before running this script.");
}

const dryRun = process.argv.includes("--dry-run");
const pool = new pg.Pool({ connectionString: databaseUrl });

const COLUMNS: { column: "waves" | "current" | "surge" | "suit_type" | "weight_feedback"; map: Record<string, string> }[] = [
  { column: "waves", map: APP_WAVES_BY_PADI_WAVES },
  { column: "current", map: APP_CURRENT_BY_PADI_CURRENT },
  { column: "surge", map: APP_SURGE_BY_PADI_SURGE },
  { column: "suit_type", map: APP_SUIT_BY_PADI_SUIT },
  { column: "weight_feedback", map: APP_WEIGHT_BY_PADI_WEIGHT },
];

async function backfillColumn(column: string, map: Record<string, string>): Promise<{ updated: number }> {
  const { rows } = await pool.query<{ id: number; value: string }>(
    `select id, ${column} as value from dives where padi_dive_id is not null and ${column} = any($1::text[])`,
    [Object.keys(map)],
  );

  for (const row of rows) {
    const next = map[row.value];
    console.log(`dives.id=${row.id}: ${dryRun ? "would update" : "updating"} ${column} "${row.value}" -> "${next}"`);
    if (!dryRun) {
      await pool.query(`update dives set ${column} = $2 where id = $1`, [row.id, next]);
    }
  }

  return { updated: rows.length };
}

async function main() {
  let total = 0;
  for (const { column, map } of COLUMNS) {
    const { updated } = await backfillColumn(column, map);
    total += updated;
  }
  console.log(`${total} column value(s) updated across all fields.` + (dryRun ? " (dry run, nothing written)" : ""));
  await pool.end();
}

main();
