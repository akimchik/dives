import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

// Integration test against a real Postgres (helpers/pg.ts's convention: resolve
// TEST_DATABASE_URL ?? DATABASE_URL, fail loudly rather than silently skipping). Covers plan Step 5:
// per-user scoping of every dive/dive-site read and write (AGENTS.md's ownership rule), and the
// dive_backup notification each mutation enqueues inside its own transaction. Rows are keyed by a
// fresh random user per case, so this file is safe to run alongside the other integration files.
import { closeTestPool, getTestPool } from "./helpers/pg";

// templates.mjs is the consumer of the payload written here -- asserting against it directly is what
// proves the flat `{ event, dive: { ...columns, site_name, ... } }` contract end-to-end, rather than
// just re-stating the field names this test itself wrote.
// scripts/** is plain .mjs with no type declarations (the worker runs outside the Next build).
// @ts-expect-error -- untyped .mjs module, imported on purpose to assert against the real renderer
import { orderedDiveColumns, renderDiveBackupEmail } from "../../scripts/notifications/templates.mjs";

const {
  createDive,
  deleteDive,
  findOrCreateDiveSite,
  getDive,
  getDiveActivityByDay,
  getDiveStats,
  listDiveSites,
  listDives,
  listRecentCylinders,
  updateDive,
  DiveNotFoundError,
  DiveSiteNotFoundError,
} = await import("@/lib/dives");

type Owner = { id: string; email: string };

async function createOwner(): Promise<Owner> {
  const email = `dive-${randomUUID()}@example.com`;
  const result = await getTestPool().query<{ id: number }>(
    "insert into users (email, password_hash) values ($1, 'x') returning id",
    [email],
  );

  return { id: String(result.rows[0].id), email };
}

// pg throws on an `undefined` query param (unlike `null`, which is fine) -- every DiveInput field
// must be explicitly present here, even the ones this file doesn't otherwise care about, or
// createDive/updateDive fail at the database call, not at the type-check (the `as` cast below
// doesn't catch a field being merely absent from the object literal).
function diveInput(overrides: Record<string, unknown> = {}) {
  return {
    site: null,
    title: null,
    occurredAt: "2026-08-09T07:30:00.000Z",
    maxDepth: 30.5,
    avgDepth: 18.25,
    bottomTimeMinutes: 44,
    waterTemp: 26.5,
    waterTempLow: null,
    airTemp: null,
    visibility: 20,
    gasMix: "EAN32",
    tankInfo: "12L steel",
    cylinderSize: null,
    startPressure: null,
    endPressure: null,
    weight: 6,
    weightFeedback: null,
    suitType: "3mm shorty",
    hood: null,
    gloves: null,
    boots: null,
    buddy: "Sam",
    diveShop: "Blue Bubble Divers",
    current: "mild",
    surge: "none",
    waves: null,
    weather: "sunny",
    waterType: null,
    bodyOfWater: null,
    entryType: "boat",
    notes: 'said "wow", twice',
    rating: 5,
    depthProfile: [
      { t: 0, d: 0 },
      { t: 60, d: 12.4 },
    ],
    depthProfileRaw: "0,0\n60,12.4\n",
    ...overrides,
  } as Parameters<typeof createDive>[1];
}

async function backupRows(diveId: number, event: string) {
  const result = await getTestPool().query(
    `
      select id, recipient_email, notification_type, idempotency_key, payload
      from notification_queue
      where idempotency_key like $1
      order by id asc
    `,
    [`dive-backup:${diveId}:${event}:%`],
  );

  return result.rows;
}

afterAll(async () => {
  await closeTestPool();
});

describe("dive mutations enqueue a dive_backup notification in the same transaction", () => {
  it("creates a dive and enqueues exactly one dive_backup row carrying the flat payload contract", async () => {
    const owner = await createOwner();
    const siteName = `Blue Hole ${randomUUID().slice(0, 8)}`;

    const dive = await createDive(
      owner,
      diveInput({ site: { name: siteName, location: "Dahab", lat: 28.5721, lng: 34.5372 } }),
    );

    const rows = await backupRows(dive.id, "create");
    expect(rows).toHaveLength(1);
    expect(rows[0].notification_type).toBe("dive_backup");
    expect(rows[0].recipient_email).toBe(owner.email);

    const payload = rows[0].payload;
    expect(payload.event).toBe("create");

    // Flat, per the contract: the site arrives as site_* columns, not a nested `site` object (the
    // CSV attachment writes one cell per key, so a nested object would collapse into one cell).
    expect(payload.dive.site_name).toBe(siteName);
    expect(payload.dive.site_location).toBe("Dahab");
    expect(payload.dive.site_lat).toBeCloseTo(28.5721);
    expect(payload.dive.site_lng).toBeCloseTo(34.5372);
    expect(payload.dive.site).toBeUndefined();

    expect(payload.dive.id).toBe(dive.id);
    expect(payload.dive.max_depth).toBe("30.50");
    expect(payload.dive.bottom_time_minutes).toBe(44);
    expect(payload.dive.notes).toBe('said "wow", twice');
    expect(payload.dive.depth_profile).toEqual([
      { t: 0, d: 0 },
      { t: 60, d: 12.4 },
    ]);
    expect(payload.dive.depth_profile_raw).toBe("0,0\n60,12.4\n");

    // depth_profile is the one key the CSV builder is allowed to JSON-stringify into a single cell;
    // everything else must already be a scalar.
    for (const [key, value] of Object.entries(payload.dive)) {
      if (key === "depth_profile") continue;
      expect(value === null || typeof value !== "object").toBe(true);
    }

    // Internal ownership columns stay out of the user's backup email entirely.
    expect(payload.dive.user_id).toBeUndefined();
    expect(payload.dive.dive_site_id).toBeUndefined();
  });

  it("renders through the worker's own template/CSV column builder", async () => {
    const owner = await createOwner();
    const siteName = `Shark Reef ${randomUUID().slice(0, 8)}`;

    const dive = await createDive(owner, diveInput({ site: { name: siteName, location: "Sinai" } }));
    const [row] = await backupRows(dive.id, "create");

    const email = renderDiveBackupEmail(row.payload);
    expect(email.subject).toContain(siteName);
    expect(email.text).toContain(`Dive site: ${siteName}`);
    expect(email.text).toContain("Location: Sinai");
    expect(email.text).toContain("Max depth: 30.50");
    expect(email.text).toContain("Bottom time (min): 44");
    // Every key the payload carries maps to a known human label -- an unlabelled key would show up
    // as a humanised column name like "Dive site id" or "User id".
    expect(email.text).not.toMatch(/^User id:/m);
    expect(email.text).not.toMatch(/^Dive site id:/m);

    const columns = orderedDiveColumns(row.payload.dive);
    expect(columns).toContain("site_name");
    expect(columns).toContain("site_location");
    expect(columns[0]).toBe("id");
  });

  it("round-trips the extended TODO.md fields (title, gas pressures, gear, conditions)", async () => {
    const owner = await createOwner();

    const dive = await createDive(
      owner,
      diveInput({
        title: "Night dive with the reef sharks",
        waterTempLow: 21.0,
        airTemp: 29.5,
        cylinderSize: 12,
        startPressure: 200,
        endPressure: 50,
        weightFeedback: "Perfect",
        hood: true,
        gloves: false,
        boots: true,
        waves: "Mild",
        waterType: "Salt",
        bodyOfWater: "Cenote",
      }),
    );

    const stored = await getDive(owner.id, dive.id);
    expect(stored?.title).toBe("Night dive with the reef sharks");
    expect(stored?.water_temp_low).toBe("21.0");
    expect(stored?.air_temp).toBe("29.5");
    expect(stored?.cylinder_size).toBe("12.00");
    expect(stored?.start_pressure).toBe("200.00");
    expect(stored?.end_pressure).toBe("50.00");
    expect(stored?.weight_feedback).toBe("Perfect");
    expect(stored?.hood).toBe(true);
    expect(stored?.gloves).toBe(false);
    expect(stored?.boots).toBe(true);
    expect(stored?.waves).toBe("Mild");
    expect(stored?.water_type).toBe("Salt");
    // "Cenote" isn't one of the fixed body-of-water choices -- confirms the single-column
    // "Other" design (no separate body_of_water_other) actually stores free text as-is.
    expect(stored?.body_of_water).toBe("Cenote");

    const [row] = await backupRows(dive.id, "create");
    expect(row.payload.dive.title).toBe("Night dive with the reef sharks");
    expect(row.payload.dive.hood).toBe(true);
    expect(row.payload.dive.gloves).toBe(false);

    const email = renderDiveBackupEmail(row.payload);
    expect(email.subject).toBe("Dive logged: Night dive with the reef sharks");
    expect(email.text).toContain("Hood: Yes");
    expect(email.text).toContain("Gloves: No");
  });

  it("enqueues one distinct row per edit -- two edits never collapse into one", async () => {
    const owner = await createOwner();
    const dive = await createDive(owner, diveInput());

    await updateDive(owner, dive.id, diveInput({ notes: "first edit" }));
    await updateDive(owner, dive.id, diveInput({ notes: "second edit" }));

    const rows = await backupRows(dive.id, "edit");
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.idempotency_key)).size).toBe(2);
    expect(rows.map((row) => row.payload.dive.notes)).toEqual(["first edit", "second edit"]);
    expect(rows.every((row) => row.payload.event === "edit")).toBe(true);
  });

  it("captures the full snapshot before deleting, since the row is gone by the time the worker drains", async () => {
    const owner = await createOwner();
    const siteName = `Wreck ${randomUUID().slice(0, 8)}`;
    const dive = await createDive(owner, diveInput({ site: { name: siteName } }));

    await deleteDive(owner, dive.id);

    expect(await getDive(owner.id, dive.id)).toBeNull();

    const rows = await backupRows(dive.id, "delete");
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.event).toBe("delete");
    expect(rows[0].payload.dive.id).toBe(dive.id);
    expect(rows[0].payload.dive.site_name).toBe(siteName);
    expect(rows[0].payload.dive.bottom_time_minutes).toBe(44);
  });
});

describe("dive sites are per-user", () => {
  it("reuses an existing site of the same user by name instead of duplicating it", async () => {
    const owner = await createOwner();
    const name = `Manta Point ${randomUUID().slice(0, 8)}`;

    const first = await findOrCreateDiveSite(owner.id, { name, location: "Nusa Penida" });
    const second = await findOrCreateDiveSite(owner.id, { name: name.toUpperCase() });

    expect(second.id).toBe(first.id);
    expect(await listDiveSites(owner.id)).toHaveLength(1);
  });

  it("creates a same-named site per user and never lists another user's sites", async () => {
    const alice = await createOwner();
    const bob = await createOwner();
    const name = `Coral Garden ${randomUUID().slice(0, 8)}`;

    const aliceSite = await findOrCreateDiveSite(alice.id, { name });
    const bobSite = await findOrCreateDiveSite(bob.id, { name });

    expect(bobSite.id).not.toBe(aliceSite.id);
    expect(await listDiveSites(alice.id)).toEqual([expect.objectContaining({ id: aliceSite.id })]);
    expect(await listDiveSites(bob.id, name)).toEqual([expect.objectContaining({ id: bobSite.id })]);
  });
});

describe("cross-user access (IDOR)", () => {
  it("never reads, edits or deletes another user's dive by id", async () => {
    const alice = await createOwner();
    const bob = await createOwner();

    const bobDive = await createDive(bob, diveInput({ notes: "bob's dive" }));

    // Read: detail, list and stats all stay scoped to the session user.
    expect(await getDive(alice.id, bobDive.id)).toBeNull();
    expect(await listDives(alice.id)).toEqual([]);
    expect(await getDiveStats(alice.id)).toEqual({
      totalDives: 0,
      totalBottomTimeMinutes: 0,
      deepestDepth: null,
      distinctSites: 0,
    });

    // Edit: fails closed and leaves the row untouched.
    await expect(updateDive(alice, bobDive.id, diveInput({ notes: "hijacked" }))).rejects.toThrow(
      DiveNotFoundError,
    );
    expect((await getDive(bob.id, bobDive.id))?.notes).toBe("bob's dive");

    // Delete: fails closed and leaves the row in place.
    await expect(deleteDive(alice, bobDive.id)).rejects.toThrow(DiveNotFoundError);
    expect(await getDive(bob.id, bobDive.id)).not.toBeNull();

    // A failed mutation must not enqueue a backup either -- write and enqueue share one transaction.
    const leaked = await getTestPool().query(
      "select id from notification_queue where recipient_email = $1",
      [alice.email],
    );
    expect(leaked.rows).toEqual([]);
  });

  it("refuses to attach another user's dive site to a dive", async () => {
    const alice = await createOwner();
    const bob = await createOwner();
    const bobSite = await findOrCreateDiveSite(bob.id, { name: `Bob's Bay ${randomUUID().slice(0, 8)}` });

    await expect(createDive(alice, diveInput({ site: { id: bobSite.id } }))).rejects.toThrow(
      DiveSiteNotFoundError,
    );

    expect(await listDives(alice.id)).toEqual([]);
  });
});

describe("dashboard stats", () => {
  it("aggregates only the session user's own dives", async () => {
    const owner = await createOwner();
    const siteName = `Stats Reef ${randomUUID().slice(0, 8)}`;

    await createDive(owner, diveInput({ site: { name: siteName }, maxDepth: 12, bottomTimeMinutes: 30 }));
    await createDive(owner, diveInput({ site: { name: siteName }, maxDepth: 41.2, bottomTimeMinutes: 25 }));

    expect(await getDiveStats(owner.id)).toEqual({
      totalDives: 2,
      totalBottomTimeMinutes: 55,
      deepestDepth: "41.20",
      distinctSites: 1,
    });
  });
});

describe("listRecentCylinders", () => {
  it("orders by the dive's own occurred_at, not creation order, and de-duplicates", async () => {
    const owner = await createOwner();

    // Created in this order: 12L (old dive) -> 15L (newer dive) -> 12L again, but dated NEWER
    // than the 15L dive -- proves ordering follows occurred_at, not insertion order.
    await createDive(
      owner,
      diveInput({ occurredAt: "2026-01-01T09:00:00.000Z", tankInfo: "12L steel", cylinderSize: 12 }),
    );
    await createDive(
      owner,
      diveInput({ occurredAt: "2026-02-01T09:00:00.000Z", tankInfo: "15L steel", cylinderSize: 15 }),
    );
    await createDive(
      owner,
      diveInput({ occurredAt: "2026-03-01T09:00:00.000Z", tankInfo: "12L steel", cylinderSize: 12 }),
    );

    expect(await listRecentCylinders(owner.id)).toEqual([
      { tankInfo: "12L steel", cylinderSize: "12.00" },
      { tankInfo: "15L steel", cylinderSize: "15.00" },
    ]);
  });

  it("returns only the 5 most recent distinct cylinders, oldest excluded", async () => {
    const owner = await createOwner();

    for (let i = 0; i < 6; i += 1) {
      await createDive(
        owner,
        diveInput({
          occurredAt: `2026-0${i + 1}-01T09:00:00.000Z`,
          tankInfo: `Cylinder ${i}`,
          cylinderSize: 10 + i,
        }),
      );
    }

    const result = await listRecentCylinders(owner.id);
    expect(result).toHaveLength(5);
    expect(result.map((c) => c.tankInfo)).toEqual([
      "Cylinder 5",
      "Cylinder 4",
      "Cylinder 3",
      "Cylinder 2",
      "Cylinder 1",
    ]);
    expect(result.map((c) => c.tankInfo)).not.toContain("Cylinder 0");
  });

  it("skips dives with neither field recorded and never returns another user's cylinders", async () => {
    const alice = await createOwner();
    const bob = await createOwner();

    await createDive(alice, diveInput({ tankInfo: null, cylinderSize: null }));
    await createDive(bob, diveInput({ tankInfo: "Bob's 12L", cylinderSize: 12 }));

    expect(await listRecentCylinders(alice.id)).toEqual([]);
  });
});

describe("getDiveActivityByDay", () => {
  it("groups dive counts by day within the range, scoped to the session user", async () => {
    const owner = await createOwner();
    const other = await createOwner();

    await createDive(owner, diveInput({ occurredAt: "2026-06-01T08:00:00.000Z" }));
    await createDive(owner, diveInput({ occurredAt: "2026-06-01T15:00:00.000Z" }));
    await createDive(owner, diveInput({ occurredAt: "2026-06-03T08:00:00.000Z" }));
    // Outside the queried range and belonging to another user -- neither should appear.
    await createDive(owner, diveInput({ occurredAt: "2026-07-15T08:00:00.000Z" }));
    await createDive(other, diveInput({ occurredAt: "2026-06-01T08:00:00.000Z" }));

    const result = await getDiveActivityByDay(owner.id, {
      from: new Date("2026-06-01T00:00:00.000Z"),
      to: new Date("2026-07-01T00:00:00.000Z"),
    });

    expect(result).toEqual([
      { date: "2026-06-01", count: 2 },
      { date: "2026-06-03", count: 1 },
    ]);
  });
});
