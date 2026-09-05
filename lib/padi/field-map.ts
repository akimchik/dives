// Maps a single PADI `logbook_logs` detail record (the "Get Log record" query response, see
// `scratch`/`padi-log-backup.json`) onto the subset of `DiveInput` this app can populate, plus the
// 8 PADI-only columns `createDiveFromPadi` (lib/dives.ts, a later story) writes directly.
//
// Two rules found during plan review (v3 changelog fix #7, #9) and re-affirmed as fix C:
//
// 1. Array unwrap: `depth_times`, `conditions`, `equipment`, `experiences` (and `skills`, unused
//    here) are each returned as a 1-ELEMENT ARRAY, not a plain object. Reading them directly
//    (`record.conditions.water_type`) silently imports every dive with every measurement `null`
//    while the sync still reports success. Always unwrap via `record.field?.[0] ?? {}`.
// 2. Date handling: `dive_date` arrives with no timezone offset (`"2026-08-30T00:00:00"`). Treated
//    as UTC midnight by appending `"Z"` before constructing the `Date`, so the resulting instant is
//    stable across this app's local dev machine, its UTC k8s pod, and browsers in other timezones.
//    A missing/unparseable `dive_date` fails the whole mapping rather than producing a dive with a
//    null `occurred_at` (that column is `not null`).
import type { DiveInput } from "@/lib/dives";

interface PadiDepthTimes {
  max_depth: number | null;
  bottom_time: number | null;
  time_in: unknown;
  time_out: unknown;
}

interface PadiConditions {
  water_type: string | null;
  body_of_water: string | null;
  weather: string | null;
  air_temp: number | null;
  surface_water_temp: number | null;
  bottom_water_temp: number | null;
  visibility: string | null;
  visibility_distance: number | null;
  wave_condition: string | null;
  current: string | null;
  surge: string | null;
}

interface PadiEquipment {
  suit_type: string | null;
  weight: number | null;
  weight_type: string | null;
  additional_equipment: string[] | null;
  cylinder_type: string | null;
  cylinder_size: number | null;
  gas_mixture: string | null;
  oxygen: number | null;
  nitrogen: number | null;
  helium: number | null;
  starting_pressure: number | null;
  ending_pressure: number | null;
}

interface PadiExperiences {
  feeling: string | null;
  notes: string | null;
  buddies: string | null;
  dive_center: string | null;
}

interface PadiSkills {
  dive_skills: unknown[];
}

// The shape of one element of `data.logbook_logs` from the detail query in `scratch`/
// `padi-log-backup.json`. `depth_times`/`conditions`/`equipment`/`experiences`/`skills` are each a
// 1-element array -- see the array-unwrap rule above.
export interface PadiLogbookDetail {
  id: number;
  log_type: string | null;
  log_course: string | null;
  log_number: number | null;
  dive_type: string | null;
  dive_title: string | null;
  dive_date: string | null;
  dive_location: string | null;
  memsys_member_number: number | null;
  status: string | null;
  adventure_dive: string | null;
  depth_times?: PadiDepthTimes[] | null;
  skills?: PadiSkills[] | null;
  conditions?: PadiConditions[] | null;
  equipment?: PadiEquipment[] | null;
  experiences?: PadiExperiences[] | null;
}

// The 8 columns migration 023 adds to `dives`, written once by `createDiveFromPadi`'s own insert
// and never touched by the ordinary `DiveInput`/`diveValues()`/`updateDive` path (v2 data-loss fix).
// `status` is deliberately renamed `padi_status` to avoid colliding with `padi_integrations.status`/
// `notification_queue.status`.
export interface PadiOnlyFields {
  padi_dive_id: number;
  dive_number: number | null;
  padi_member_number: number | null;
  adventure_dive: boolean;
  dive_type: string | null;
  log_type: string | null;
  log_course: string | null;
  padi_status: string | null;
}

export type MapPadiLogResult =
  | { ok: true; diveInput: Partial<DiveInput>; padiFields: PadiOnlyFields }
  | { ok: false; reason: "missing_dive_date" };

// Dot-path field names this mapper reads and actually uses, for the completeness test's benefit.
// Top-level PADI keys are bare (e.g. "dive_title"); keys nested inside one of the unwrapped
// container arrays are prefixed by the container name (e.g. "conditions.air_temp"). The 5
// container keys themselves ("depth_times", "conditions", "equipment", "experiences", "skills")
// are structural -- they're unwrapped, not read directly -- so they're listed separately below
// rather than in either set.
export const MAPPED_FIELDS = new Set<string>([
  "id",
  "dive_date",
  "dive_title",
  "dive_location",
  "log_number",
  "memsys_member_number",
  "adventure_dive",
  "dive_type",
  "log_type",
  "log_course",
  "status",
  "depth_times.max_depth",
  "depth_times.bottom_time",
  "conditions.air_temp",
  "conditions.surface_water_temp",
  "conditions.bottom_water_temp",
  "conditions.visibility_distance",
  "conditions.water_type",
  "conditions.body_of_water",
  "conditions.weather",
  "conditions.wave_condition",
  "conditions.current",
  "conditions.surge",
  "equipment.suit_type",
  "equipment.weight",
  "equipment.weight_type",
  "equipment.additional_equipment",
  "equipment.cylinder_type",
  "equipment.cylinder_size",
  "equipment.gas_mixture",
  "equipment.starting_pressure",
  "equipment.ending_pressure",
  "experiences.notes",
  "experiences.buddies",
  "experiences.dive_center",
  "experiences.feeling",
]);

// Fields PADI sends that have no home in this app -- deliberately unmapped, not just forgotten.
export const UNMAPPED_FIELDS = new Set<string>([
  "depth_times.time_in",
  "depth_times.time_out",
  "conditions.visibility",
  "equipment.oxygen",
  "equipment.nitrogen",
  "equipment.helium",
  "skills.dive_skills",
]);

// The 5 top-level keys that are 1-element-array containers rather than plain fields (see the
// array-unwrap rule above). Not themselves entries in MAPPED_FIELDS/UNMAPPED_FIELDS -- their
// nested keys are, under a "container.field" dot-path.
export const CONTAINER_KEYS = new Set<string>([
  "depth_times",
  "skills",
  "conditions",
  "equipment",
  "experiences",
]);

function parseUtcMidnight(diveDate: string | null | undefined): Date | null {
  if (!diveDate) return null;
  const date = new Date(`${diveDate}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

// PADI's dive_type (observed values: "BeachShore", "Boat" -- see padi-log-backup.json) is the
// closest PADI field to this app's own entry_type selector (components/dive-form.tsx's
// ENTRY_TYPES: "Shore"/"Boat"/"Liveaboard"/"Pier / jetty"/"Drift"). entry_type is a free-text
// column with no CHECK constraint, so an unrecognized future PADI value passes through verbatim
// (visible and editable, matching how body_of_water already handles an "Other" free-form value)
// rather than being silently dropped.
const ENTRY_TYPE_BY_PADI_DIVE_TYPE: Record<string, string> = {
  BeachShore: "Shore",
  Boat: "Boat",
};

function mapEntryType(padiDiveType: string | null): string | null {
  if (!padiDiveType) return null;
  return ENTRY_TYPE_BY_PADI_DIVE_TYPE[padiDiveType] ?? padiDiveType;
}

// dive_location -> a dive site, resolved by createDiveFromPadi via the same name-based
// create-or-reuse (findOrCreateDiveSite) the manual dive form already uses: an existing site of
// this user with the same (case-insensitive) name is reused rather than duplicated, so importing
// the same location across many dives converges on one dive_sites row. No lat/lng -- PADI's
// logbook export doesn't include coordinates, only a free-text location name.
function mapSite(diveLocation: string | null): DiveInput["site"] {
  const name = diveLocation?.trim();
  return name ? { name } : null;
}

// experiences.feeling -> rating (dives.rating is `smallint check (rating between 1 and 5)`).
// Only 4 distinct values have ever been observed across a real 75-dive export (Poor/Average/Good/
// Amazing -- no null-adjacent "Fair"/"Terrible" tier seen), so this is a best-effort ordinal
// mapping by what the words mean on a 1-5 quality scale, not a confirmed PADI enum-to-star-count
// spec: Poor=1, Average=3 (the middle of the scale, matching its name), Good=4, Amazing=5. Rating
// 2 is intentionally unreachable from PADI data -- there's no observed PADI word that means
// "between Poor and Average" to place there. An unrecognized future value (or PADI sending no
// feeling at all) maps to `null` (unrated) rather than a guessed number, since `rating`'s CHECK
// constraint means a wrong guess can't be corrected by passthrough the way entry_type's free-text
// column allows.
const RATING_BY_PADI_FEELING: Record<string, number> = {
  Poor: 1,
  Average: 3,
  Good: 4,
  Amazing: 5,
};

function mapRating(feeling: string | null): number | null {
  if (!feeling) return null;
  return RATING_BY_PADI_FEELING[feeling] ?? null;
}

export function mapPadiLogToDive(record: PadiLogbookDetail): MapPadiLogResult {
  const occurredAt = parseUtcMidnight(record.dive_date);
  if (!occurredAt) {
    return { ok: false, reason: "missing_dive_date" };
  }

  const depthTimes = record.depth_times?.[0] ?? ({} as Partial<PadiDepthTimes>);
  const conditions = record.conditions?.[0] ?? ({} as Partial<PadiConditions>);
  const equipment = record.equipment?.[0] ?? ({} as Partial<PadiEquipment>);
  const experiences = record.experiences?.[0] ?? ({} as Partial<PadiExperiences>);

  const additionalEquipment = equipment.additional_equipment ?? [];

  const diveInput: Partial<DiveInput> = {
    site: mapSite(record.dive_location),
    title: record.dive_title ?? null,
    occurredAt,
    maxDepth: depthTimes.max_depth ?? null,
    bottomTimeMinutes: depthTimes.bottom_time ?? null,
    airTemp: conditions.air_temp ?? null,
    waterTemp: conditions.surface_water_temp ?? null,
    waterTempLow: conditions.bottom_water_temp ?? null,
    visibility: conditions.visibility_distance ?? null,
    waterType: conditions.water_type ?? null,
    bodyOfWater: conditions.body_of_water ?? null,
    weather: conditions.weather ?? null,
    waves: conditions.wave_condition ?? null,
    current: conditions.current ?? null,
    surge: conditions.surge ?? null,
    suitType: equipment.suit_type ?? null,
    weight: equipment.weight ?? null,
    weightFeedback: equipment.weight_type ?? null,
    cylinderSize: equipment.cylinder_size ?? null,
    tankInfo: equipment.cylinder_type ?? null,
    gasMix: equipment.gas_mixture ?? null,
    startPressure: equipment.starting_pressure ?? null,
    endPressure: equipment.ending_pressure ?? null,
    hood: additionalEquipment.includes("Hood"),
    gloves: additionalEquipment.includes("Gloves"),
    boots: additionalEquipment.includes("Boots"),
    notes: experiences.notes ?? null,
    buddy: experiences.buddies ?? null,
    diveShop: experiences.dive_center ?? null,
    entryType: mapEntryType(record.dive_type),
    rating: mapRating(experiences.feeling ?? null),
  };

  const padiFields: PadiOnlyFields = {
    padi_dive_id: record.id,
    dive_number: record.log_number ?? null,
    padi_member_number: record.memsys_member_number ?? null,
    adventure_dive: Boolean(record.adventure_dive),
    dive_type: record.dive_type ?? null,
    log_type: record.log_type ?? null,
    log_course: record.log_course ?? null,
    padi_status: record.status ?? null,
  };

  return { ok: true, diveInput, padiFields };
}
