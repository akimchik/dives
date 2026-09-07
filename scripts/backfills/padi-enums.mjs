// Issue #20: before this fix, PADI import stored PADI's own enum codes (e.g. "SmallWaves",
// "SomeCurrent", "FullSuit_7mm") verbatim in dives.waves/current/surge/suit_type/weight_feedback
// instead of translating them to this app's own vocabulary (see lib/padi/field-map.ts /
// lib/padi/enum-map.ts). Fixing the mapper only changes what happens on the *next* import -- it
// doesn't touch rows already in the table, and re-running "Sync from PADI" doesn't help either
// (lib/padi/sync.ts only inserts new dives, dedup'd by padi_dive_id; it never rewrites an
// already-imported one). This backfill re-applies the current reverse maps to every PADI-imported
// dive still holding a raw PADI code.
//
// Only rewrites a column when its current value is a *recognized* PADI code (a key in the reverse
// map) -- i.e. a value this fix now knows how to translate. A column already holding an app-format
// value, or a genuinely unrecognized future PADI code with no map entry either direction, is left
// untouched (the latter keeps showing the dive-form's "unrecognized value" warning, which is the
// intended fallback UX for issue #20, not a bug this backfill should paper over).
//
// Idempotent, per the runner's contract (scripts/run-backfills.mjs): a column already in app format
// has no matching reverse-map key, and self-mapping entries (a PADI code that equals its own app
// value) are excluded from the rewrite entirely, so every run after the first touches zero rows.
//
// Mirrors lib/padi/enum-map.ts's forward (app -> PADI) maps by hand rather than importing them --
// see scripts/run-backfills.mjs's contract note on why backfills here can't import from lib/. If
// those forward maps ever change, mirror the change here too.

function invert(map) {
  const inverted = {};
  for (const [key, value] of Object.entries(map)) {
    if (value in inverted) throw new Error(`padi-enums backfill: "${value}" is not a unique value, can't invert`);
    inverted[value] = key;
  }
  return inverted;
}

const PADI_SUIT_BY_APP_SUIT = {
  "Skin / rash guard": "SkinSuit",
  Shorty: "Shorty",
  "Wetsuit 3mm": "FullSuit_3mm",
  "Wetsuit 5mm": "FullSuit_5mm",
  "Wetsuit 7mm": "FullSuit_7mm",
  "Semi-dry": "SemiDrySuit",
  Drysuit: "DrySuit",
};

const PADI_WEIGHT_BY_APP_WEIGHT = {
  Underweight: "Light",
  Perfect: "Good",
  Overweight: "Heavy",
};

const PADI_WAVES_BY_APP_INTENSITY = {
  None: "NoWaves",
  Mild: "SmallWaves",
  Moderate: "MediumWaves",
  Strong: "LargeWaves",
};

const PADI_CURRENT_BY_APP_INTENSITY = {
  None: "NoCurrent",
  Mild: "SomeCurrent",
  Moderate: "MediumCurrent",
  Strong: "StrongCurrent",
};

const PADI_SURGE_BY_APP_INTENSITY = {
  None: "NoSurge",
  Mild: "SomeSurge",
  Moderate: "MediumSurge",
  Strong: "StrongSurge",
};

const COLUMNS = [
  { column: "waves", map: invert(PADI_WAVES_BY_APP_INTENSITY) },
  { column: "current", map: invert(PADI_CURRENT_BY_APP_INTENSITY) },
  { column: "surge", map: invert(PADI_SURGE_BY_APP_INTENSITY) },
  { column: "suit_type", map: invert(PADI_SUIT_BY_APP_SUIT) },
  { column: "weight_feedback", map: invert(PADI_WEIGHT_BY_APP_WEIGHT) },
];

async function backfillColumn(pool, column, map, dryRun) {
  // Drop self-mapping entries (e.g. suit_type's "Shorty" -> "Shorty") -- rewriting a row to the
  // value it already holds isn't a real update, and would make idempotency claims false.
  const entries = Object.entries(map).filter(([from, to]) => from !== to);
  if (entries.length === 0) return 0;

  const { rows } = await pool.query(
    `select id, ${column} as value from dives where padi_dive_id is not null and ${column} = any($1::text[])`,
    [entries.map(([from]) => from)],
  );
  if (rows.length === 0) return 0;

  for (const row of rows) {
    console.log(`padi-enums: dives.id=${row.id}: ${dryRun ? "would update" : "updating"} ${column} "${row.value}" -> "${map[row.value]}"`);
  }

  if (!dryRun) {
    // One bulk UPDATE per column (a handful of distinct code pairs) rather than one round trip per
    // matched row (there can be thousands of those).
    const valuesSql = entries.map((_, index) => `($${index * 2 + 1}::text, $${index * 2 + 2}::text)`).join(", ");
    await pool.query(
      `update dives set ${column} = v.next
       from (values ${valuesSql}) as v(prev, next)
       where dives.padi_dive_id is not null and dives.${column} = v.prev`,
      entries.flat(),
    );
  }

  return rows.length;
}

export default async function backfill(pool, { dryRun }) {
  let total = 0;
  for (const { column, map } of COLUMNS) {
    total += await backfillColumn(pool, column, map, dryRun);
  }
  console.log(`padi-enums: ${total} column value(s) updated across all fields.` + (dryRun ? " (dry run, nothing written)" : ""));
}
