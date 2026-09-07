import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

// Integration test against a real Postgres (see tests/integration/dives.test.ts for the same
// convention). Covers plan Step 9 / PRD US-005: createDiveFromPadi's insert-once, conflict-safe
// dedup, and -- most importantly -- the direct regression test for the v2 data-loss bug found
// during planning review: an ordinary edit through the untouched updateDive path must never null
// out the 8 PADI-only columns createDiveFromPadi writes.
import { closeTestPool, getTestPool } from "./helpers/pg";

const { createDiveFromPadi, getDive, listDiveSites, updateDive } = await import("@/lib/dives");
type PadiOnlyFields = import("@/lib/padi/field-map").PadiOnlyFields;

type Owner = { id: string; email: string };

async function createOwner(): Promise<Owner> {
  const email = `padi-dive-${randomUUID()}@example.com`;
  const result = await getTestPool().query<{ id: number }>(
    "insert into users (email, password_hash) values ($1, 'x') returning id",
    [email],
  );

  return { id: String(result.rows[0].id), email };
}

// Same "every DiveInput field must be explicitly present, undefined throws at the pg call not the
// type-check" note as tests/integration/dives.test.ts's diveInput() -- but createDiveFromPadi
// accepts a Partial<DiveInput> and fills the rest itself, so this fixture intentionally stays
// partial, mirroring what lib/padi/field-map.ts's mapPadiLogToDive actually produces.
function padiDiveInput(overrides: Record<string, unknown> = {}) {
  return {
    title: "Left from mol",
    occurredAt: new Date("2026-08-30T00:00:00Z"),
    maxDepth: 8.8,
    bottomTimeMinutes: 54,
    waterType: "Salt",
    bodyOfWater: "Ocean",
    weather: "Rainy",
    airTemp: 20,
    waterTemp: 20,
    waterTempLow: 20,
    visibility: 4,
    waves: "Mild",
    current: "Mild",
    surge: "Moderate",
    suitType: "Wetsuit 7mm",
    weight: 6,
    weightFeedback: "Perfect",
    hood: true,
    gloves: false,
    boots: true,
    tankInfo: "Steel",
    cylinderSize: 14,
    gasMix: "Air",
    startPressure: 185,
    endPressure: 94,
    notes: "2nd time 2x7 twinset.",
    buddy: "Alexei and Eric",
    diveShop: "Aquabubblemakerclub",
    ...overrides,
  };
}

function padiFields(overrides: Partial<PadiOnlyFields> = {}): PadiOnlyFields {
  return {
    padi_dive_id: 22238544,
    dive_number: null,
    padi_member_number: 0,
    adventure_dive: false,
    dive_type: "BeachShore",
    log_type: "Recreational",
    log_course: null,
    padi_status: "Publish",
    ...overrides,
  };
}

async function notificationCount(recipientEmail: string) {
  const result = await getTestPool().query(
    "select count(*)::int as count from notification_queue where recipient_email = $1",
    [recipientEmail],
  );
  return result.rows[0].count as number;
}

afterAll(async () => {
  await closeTestPool();
});

describe("createDiveFromPadi", () => {
  it("inserts a dive with the 8 PADI-only columns set and readable back via getDive", async () => {
    const owner = await createOwner();

    const result = await createDiveFromPadi(owner, padiDiveInput(), padiFields());
    expect(result.inserted).toBe(true);
    if (!result.inserted) throw new Error("unreachable");

    const stored = await getDive(owner.id, result.id);
    expect(stored?.title).toBe("Left from mol");
    expect(stored?.padi_dive_id).toBe(22238544);
    expect(stored?.dive_number).toBeNull();
    expect(stored?.padi_member_number).toBe(0);
    expect(stored?.adventure_dive).toBe(false);
    expect(stored?.dive_type).toBe("BeachShore");
    expect(stored?.log_type).toBe("Recreational");
    expect(stored?.log_course).toBeNull();
    expect(stored?.padi_status).toBe("Publish");
    expect(stored?.padi_needs_update).toBe(false);
  });

  it("is idempotent: a second insert with the same (user_id, padi_dive_id) does not duplicate", async () => {
    const owner = await createOwner();

    const first = await createDiveFromPadi(owner, padiDiveInput(), padiFields({ padi_dive_id: 999001 }));
    expect(first.inserted).toBe(true);

    const second = await createDiveFromPadi(
      owner,
      padiDiveInput({ title: "should not land" }),
      padiFields({ padi_dive_id: 999001 }),
    );
    expect(second).toEqual({ inserted: false });

    const rows = await getTestPool().query("select count(*)::int as count from dives where user_id = $1", [
      owner.id,
    ]);
    expect(rows.rows[0].count).toBe(1);
  });

  it("resolves a PADI dive_location into a dive site, same as the manual dive form", async () => {
    const owner = await createOwner();
    const siteName = `Blue Hole ${randomUUID().slice(0, 8)}`;

    const result = await createDiveFromPadi(
      owner,
      padiDiveInput({ site: { name: siteName } }),
      padiFields({ padi_dive_id: 999010 }),
    );
    expect(result.inserted).toBe(true);
    if (!result.inserted) throw new Error("unreachable");

    const stored = await getDive(owner.id, result.id);
    expect(stored?.dive_site_id).not.toBeNull();
    expect(stored?.site_name).toBe(siteName);
  });

  it("reuses an existing site (case-insensitively) across imports instead of duplicating it", async () => {
    const owner = await createOwner();
    const siteName = `Manta Point ${randomUUID().slice(0, 8)}`;

    await createDiveFromPadi(
      owner,
      padiDiveInput({ site: { name: siteName } }),
      padiFields({ padi_dive_id: 999011 }),
    );
    await createDiveFromPadi(
      owner,
      padiDiveInput({ site: { name: siteName.toUpperCase() } }),
      padiFields({ padi_dive_id: 999012 }),
    );

    const sites = await listDiveSites(owner.id, siteName);
    expect(sites).toHaveLength(1);
  });

  it("leaves dive_site_id null when PADI sent no dive_location", async () => {
    const owner = await createOwner();

    const result = await createDiveFromPadi(
      owner,
      padiDiveInput({ site: null }),
      padiFields({ padi_dive_id: 999013 }),
    );
    expect(result.inserted).toBe(true);
    if (!result.inserted) throw new Error("unreachable");

    const stored = await getDive(owner.id, result.id);
    expect(stored?.dive_site_id).toBeNull();
    expect(stored?.site_name).toBeNull();
  });

  it("never enqueues a dive_backup notification on import", async () => {
    const owner = await createOwner();

    await createDiveFromPadi(owner, padiDiveInput(), padiFields({ padi_dive_id: 999002 }));
    // Conflict-skip path too -- must also stay silent.
    await createDiveFromPadi(owner, padiDiveInput(), padiFields({ padi_dive_id: 999002 }));

    expect(await notificationCount(owner.email)).toBe(0);
  });

  // The direct regression test for the v2 data-loss bug: extending updateDive's shared positional
  // write path with the 8 PADI columns would silently null padi_dive_id (and the other 7) on any
  // ordinary manual edit, since the edit form never sets them and diveValues() coerces `undefined`
  // to `null`. createDiveFromPadi's columns must be completely outside that write path.
  it("survives an ordinary manual edit through the untouched updateDive path unchanged", async () => {
    const owner = await createOwner();

    const created = await createDiveFromPadi(owner, padiDiveInput(), padiFields({ padi_dive_id: 999003 }));
    expect(created.inserted).toBe(true);
    if (!created.inserted) throw new Error("unreachable");

    // An ordinary edit, exactly as the dive-edit form would submit it -- a full DiveInput with no
    // knowledge of PADI-only columns at all.
    await updateDive(owner, created.id, {
      site: null,
      title: "Edited by the user",
      occurredAt: "2026-08-30T00:00:00.000Z",
      maxDepth: 8.8,
      avgDepth: null,
      bottomTimeMinutes: 54,
      waterTemp: 20,
      waterTempLow: 20,
      airTemp: 20,
      visibility: 4,
      gasMix: "Air",
      tankInfo: "Steel",
      cylinderSize: 14,
      startPressure: 185,
      endPressure: 94,
      weight: 6,
      weightFeedback: "Perfect",
      suitType: "Wetsuit 7mm",
      hood: true,
      gloves: false,
      boots: true,
      buddy: "Alexei and Eric",
      diveShop: "Aquabubblemakerclub",
      current: "Mild",
      surge: "Moderate",
      waves: "Mild",
      weather: "Rainy",
      waterType: "Salt",
      bodyOfWater: "Ocean",
      entryType: null,
      notes: "edited notes",
      rating: null,
      depthProfile: null,
      depthProfileRaw: null,
    });

    const stored = await getDive(owner.id, created.id);
    expect(stored?.title).toBe("Edited by the user");
    expect(stored?.notes).toBe("edited notes");
    // The 8 PADI columns must be exactly what createDiveFromPadi originally wrote -- untouched.
    expect(stored?.padi_dive_id).toBe(999003);
    expect(stored?.dive_number).toBeNull();
    expect(stored?.padi_member_number).toBe(0);
    expect(stored?.adventure_dive).toBe(false);
    expect(stored?.dive_type).toBe("BeachShore");
    expect(stored?.log_type).toBe("Recreational");
    expect(stored?.log_course).toBeNull();
    expect(stored?.padi_status).toBe("Publish");
    expect(stored?.padi_needs_update).toBe(true);

    // And that ordinary edit DID flow through the normal, untouched backup path (confirms the
    // "first manual edit gets a normal backup email" behavior still works).
    expect(await notificationCount(owner.email)).toBe(1);
  });
});
