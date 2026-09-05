import { describe, expect, it } from "vitest";
import {
  CONTAINER_KEYS,
  MAPPED_FIELDS,
  UNMAPPED_FIELDS,
  mapPadiLogToDive,
  type PadiLogbookDetail,
} from "@/lib/padi/field-map";
import rawFixtures from "./fixtures/padi-logbook-records.json";

// Verbatim records taken from the real PADI "Get Log record" detail response (see
// padi-log-backup.json / the repo's scratch file) -- not hand-written. Record 0 (id 22238544) is
// the exact sample captured in scratch's "Get Log record" section.
const fixtures = rawFixtures as unknown as PadiLogbookDetail[];
const [leftFromMol, zeelandWeekend, rescueScenario, adventureNightDive] = fixtures;

// Walks one fixture record the same way the mapper does: container keys (depth_times, skills,
// conditions, equipment, experiences) are 1-element arrays that get unwrapped, so their nested
// keys are reported as "container.field" dot-paths instead of the container key itself.
function collectFieldPaths(record: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (CONTAINER_KEYS.has(key)) {
      const nested = Array.isArray(value) ? value[0] : undefined;
      if (nested && typeof nested === "object") {
        for (const nestedKey of Object.keys(nested as Record<string, unknown>)) {
          paths.push(`${key}.${nestedKey}`);
        }
      }
      continue;
    }
    paths.push(key);
  }
  return paths;
}

describe("mapPadiLogToDive", () => {
  it("unwraps the 1-element arrays and populates every mapped DiveInput field", () => {
    const result = mapPadiLogToDive(leftFromMol);
    if (!result.ok) throw new Error("expected mapping to succeed");

    expect(result.diveInput).toMatchObject({
      site: { name: "Den Osse Haven" },
      title: "Left from mol",
      maxDepth: 8.8,
      bottomTimeMinutes: 54,
      airTemp: 20,
      waterTemp: 20,
      waterTempLow: 20,
      visibility: 4,
      waterType: "Salt",
      bodyOfWater: "Ocean",
      weather: "Rainy",
      waves: "SmallWaves",
      current: "SomeCurrent",
      surge: "MediumSurge",
      suitType: "FullSuit_7mm",
      weight: 6,
      weightFeedback: "Good",
      cylinderSize: 14,
      tankInfo: "Steel",
      gasMix: "Air",
      startPressure: 185,
      endPressure: 94,
      hood: true,
      gloves: false,
      boots: true,
      notes: leftFromMol.experiences?.[0]?.notes,
      buddy: "Alexei and Eric",
      diveShop: "Aquabubblemakerclub ",
      entryType: "Shore",
      rating: 3,
    });
    expect(result.diveInput.occurredAt).toBeInstanceOf(Date);
  });

  it("maps PADI dive_type onto entry_type: BeachShore->Shore, Boat->Boat unchanged, unknown values pass through", () => {
    expect(mapPadiLogToDive({ ...leftFromMol, dive_type: "BeachShore" })).toMatchObject({
      ok: true,
      diveInput: { entryType: "Shore" },
    });
    expect(mapPadiLogToDive({ ...leftFromMol, dive_type: "Boat" })).toMatchObject({
      ok: true,
      diveInput: { entryType: "Boat" },
    });
    // A future PADI dive_type this app hasn't seen yet must still land somewhere visible/editable
    // (matching how body_of_water already handles an "Other" free-form value), not be dropped.
    expect(mapPadiLogToDive({ ...leftFromMol, dive_type: "Cave" })).toMatchObject({
      ok: true,
      diveInput: { entryType: "Cave" },
    });
    expect(mapPadiLogToDive({ ...leftFromMol, dive_type: null })).toMatchObject({
      ok: true,
      diveInput: { entryType: null },
    });
  });

  it("maps dive_location onto a name-only site selection, trimmed, or null when absent", () => {
    expect(mapPadiLogToDive({ ...leftFromMol, dive_location: "Blue Hole" })).toMatchObject({
      ok: true,
      diveInput: { site: { name: "Blue Hole" } },
    });
    expect(mapPadiLogToDive({ ...leftFromMol, dive_location: "  Blue Hole  " })).toMatchObject({
      ok: true,
      diveInput: { site: { name: "Blue Hole" } },
    });
    expect(mapPadiLogToDive({ ...leftFromMol, dive_location: null })).toMatchObject({
      ok: true,
      diveInput: { site: null },
    });
    expect(mapPadiLogToDive({ ...leftFromMol, dive_location: "   " })).toMatchObject({
      ok: true,
      diveInput: { site: null },
    });
  });

  it("maps PADI experiences.feeling onto rating: Poor=1, Average=3, Good=4, Amazing=5", () => {
    expect(mapPadiLogToDive(leftFromMol)).toMatchObject({ ok: true, diveInput: { rating: 3 } }); // Average
    expect(mapPadiLogToDive(zeelandWeekend)).toMatchObject({ ok: true, diveInput: { rating: 4 } }); // Good
    expect(mapPadiLogToDive(adventureNightDive)).toMatchObject({ ok: true, diveInput: { rating: 4 } }); // Good

    const withFeeling = (feeling: string | null) => ({
      ...leftFromMol,
      experiences: [{ ...leftFromMol.experiences![0], feeling }],
    });
    expect(mapPadiLogToDive(withFeeling("Poor"))).toMatchObject({ ok: true, diveInput: { rating: 1 } });
    expect(mapPadiLogToDive(withFeeling("Amazing"))).toMatchObject({ ok: true, diveInput: { rating: 5 } });
    // rescueScenario has no experiences.feeling at all (record has no experiences container / null).
    expect(mapPadiLogToDive(rescueScenario)).toMatchObject({ ok: true, diveInput: { rating: null } });
    // A future PADI feeling this app hasn't seen must stay unrated (null), not a guessed number --
    // unlike entry_type's free-text passthrough, rating has a `check (rating between 1 and 5)`
    // constraint a wrong guess can't safely dodge.
    expect(mapPadiLogToDive(withFeeling("Terrible"))).toMatchObject({ ok: true, diveInput: { rating: null } });
    expect(mapPadiLogToDive(withFeeling(null))).toMatchObject({ ok: true, diveInput: { rating: null } });
  });

  it("populates the PADI-only fields, including the renames and the status->padi_status rename", () => {
    const result = mapPadiLogToDive(leftFromMol);
    if (!result.ok) throw new Error("expected mapping to succeed");

    expect(result.padiFields).toEqual({
      padi_dive_id: 22238544,
      dive_number: null, // log_number is null on this record
      padi_member_number: 0, // memsys_member_number
      adventure_dive: false, // adventure_dive is null on this record
      dive_type: "BeachShore",
      log_type: "Recreational",
      log_course: null,
      padi_status: "Publish", // status
    });
  });

  it("sets gloves=true when 'Gloves' is present in additional_equipment", () => {
    const result = mapPadiLogToDive(zeelandWeekend);
    if (!result.ok) throw new Error("expected mapping to succeed");

    expect(result.diveInput).toMatchObject({ hood: true, gloves: true, boots: true });
  });

  it("applies the log_number->dive_number and memsys_member_number->padi_member_number renames on a record that has real values", () => {
    const result = mapPadiLogToDive(rescueScenario);
    if (!result.ok) throw new Error("expected mapping to succeed");

    expect(result.padiFields).toMatchObject({
      dive_number: 11,
      padi_member_number: 524631,
      log_course: "Rescue",
      padi_status: "Verified",
    });
    // additional_equipment is [] on this record -> all three booleans false, not null/undefined.
    expect(result.diveInput).toMatchObject({ hood: false, gloves: false, boots: false });
  });

  it("maps a non-null adventure_dive to true", () => {
    const result = mapPadiLogToDive(adventureNightDive);
    if (!result.ok) throw new Error("expected mapping to succeed");

    expect(result.padiFields.adventure_dive).toBe(true);
  });

  it("returns {ok: false, reason: 'missing_dive_date'} when dive_date is null", () => {
    const record: PadiLogbookDetail = { ...leftFromMol, dive_date: null };
    expect(mapPadiLogToDive(record)).toEqual({ ok: false, reason: "missing_dive_date" });
  });

  it("returns {ok: false, reason: 'missing_dive_date'} when dive_date is missing entirely", () => {
    const { dive_date: _diveDate, ...rest } = leftFromMol;
    const record = rest as PadiLogbookDetail;
    expect(mapPadiLogToDive(record)).toEqual({ ok: false, reason: "missing_dive_date" });
  });

  it("returns {ok: false, reason: 'missing_dive_date'} when dive_date fails to parse", () => {
    const record: PadiLogbookDetail = { ...leftFromMol, dive_date: "not-a-date" };
    expect(mapPadiLogToDive(record)).toEqual({ ok: false, reason: "missing_dive_date" });
  });

  it("treats an offset-less dive_date as UTC midnight, not a locally-parsed instant", () => {
    // leftFromMol.dive_date is "2026-08-30T00:00:00" (no timezone offset). Appending "Z" must
    // land on 2026-08-30 in UTC regardless of the process's local timezone.
    const result = mapPadiLogToDive(leftFromMol);
    if (!result.ok) throw new Error("expected mapping to succeed");

    const occurredAt = result.diveInput.occurredAt as Date;
    expect(occurredAt.getUTCFullYear()).toBe(2026);
    expect(occurredAt.getUTCMonth()).toBe(7); // August, 0-indexed
    expect(occurredAt.getUTCDate()).toBe(30);
    expect(occurredAt.getUTCHours()).toBe(0);
    expect(occurredAt.toISOString()).toBe("2026-08-30T00:00:00.000Z");
  });

  // Completeness assertion (catches future PADI fields silently going unmapped): every key present
  // in a real fixture record -- including nested keys inside the unwrapped conditions/equipment/
  // depth_times/experiences/skills containers -- must be either mapped or explicitly documented as
  // intentionally unmapped. A genuinely new/unhandled PADI field fails this test.
  describe("field-map completeness against the real PADI payload", () => {
    it.each(fixtures.map((record, index) => [index, record] as const))(
      "fixture record %i: every present key is mapped or explicitly unmapped",
      (_index, record) => {
        const paths = collectFieldPaths(record as unknown as Record<string, unknown>);
        expect(paths.length).toBeGreaterThan(0);
        for (const path of paths) {
          const known = MAPPED_FIELDS.has(path) || UNMAPPED_FIELDS.has(path);
          expect(known, `"${path}" is neither mapped nor listed as intentionally unmapped`).toBe(
            true,
          );
        }
      },
    );

    it("MAPPED_FIELDS and UNMAPPED_FIELDS don't overlap", () => {
      for (const field of MAPPED_FIELDS) {
        expect(UNMAPPED_FIELDS.has(field)).toBe(false);
      }
    });
  });
});
