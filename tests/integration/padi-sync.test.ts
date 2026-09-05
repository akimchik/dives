import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Integration test against a real Postgres (see tests/integration/dives.test.ts's convention).
// Covers plan Step 10 / PRD US-006: syncPadiLogbook's import/linked-diff loop, the non-blocking
// advisory lock against a concurrent double-call, and that it never triggers a dive_backup email
// storm (createDiveFromPadi's own contract, exercised here end-to-end through the real sync loop).
import { closeTestPool, getTestPool } from "./helpers/pg";

// A throwaway key for this file's own encrypted fixtures -- syncPadiLogbook reads
// process.env.PADI_TOKEN_ENCRYPTION_KEY lazily (on first encrypt/decrypt call), never at import
// time, so setting it here before any import runs is safe and matches how the app/cronjob resolve
// it in production.
const TEST_KEY_BASE64 = Buffer.from("0".repeat(32)).toString("base64");
process.env.PADI_TOKEN_ENCRYPTION_KEY = TEST_KEY_BASE64;

const { encryptSecret } = await import("@/lib/padi/crypto");
const { syncPadiLogbook } = await import("@/lib/padi/sync");
const { getDiveStats } = await import("@/lib/dives");

type Owner = { id: string; email: string };

function fakeIdToken(affiliateId: string) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ "custom:affiliate_id": affiliateId })).toString("base64url");
  return `${header}.${payload}.signature`;
}

async function createConnectedOwner(): Promise<Owner> {
  const email = `padi-sync-${randomUUID()}@example.com`;
  const userResult = await getTestPool().query<{ id: number }>(
    "insert into users (email, password_hash) values ($1, 'x') returning id",
    [email],
  );
  const id = String(userResult.rows[0].id);

  // syncPadiLogbook never reads expires_at (refreshing tokens is exclusively the token-refresh
  // cronjob's job, not sync's) -- deliberately set 1 hour out, past processPadiTokenRefresh's
  // 35-minute "due" window, so this fixture is never accidentally swept up by
  // tests/integration/padi-token-refresh.test.mjs's global (not per-file-scoped) due-row query
  // when both files' tests run in the same `pnpm test:pg` invocation (vitest runs test files in
  // parallel by default, so purging this file's own rows in afterAll isn't enough on its own --
  // the underlying bug is putting them in the due window in the first place).
  await getTestPool().query(
    `
      insert into padi_integrations
        (user_id, username_hash, access_token_encrypted, refresh_token_encrypted, id_token_encrypted, expires_at, status)
      values ($1, $2, $3, $4, $5, now() + interval '1 hour', 'connected')
    `,
    [
      id,
      `hash-${id}`,
      encryptSecret("access-token", Buffer.from(TEST_KEY_BASE64, "base64"), `${id}:access`),
      encryptSecret("refresh-token", Buffer.from(TEST_KEY_BASE64, "base64"), `${id}:refresh`),
      encryptSecret(fakeIdToken("29837190"), Buffer.from(TEST_KEY_BASE64, "base64"), `${id}:id`),
    ],
  );

  return { id, email };
}

function padiSummary(id: number, diveLocation = "Den Osse Haven", overrides: Record<string, unknown> = {}) {
  return {
    id,
    log_type: "Recreational",
    log_course: null,
    log_number: null,
    dive_title: `Dive ${id}`,
    dive_date: "2026-08-30T00:00:00",
    dive_location: diveLocation,
    status: "Publish",
    ...overrides,
  };
}

function padiDetail(id: number, diveLocation = "Den Osse Haven", overrides: Record<string, unknown> = {}) {
  return {
    id,
    log_type: "Recreational",
    log_course: null,
    log_number: null,
    dive_type: "BeachShore",
    dive_title: `Dive ${id}`,
    dive_date: "2026-08-30T00:00:00",
    dive_location: diveLocation,
    memsys_member_number: 0,
    status: "Publish",
    adventure_dive: null,
    depth_times: [{ max_depth: 8.8, bottom_time: 54, time_in: null, time_out: null }],
    skills: [{ dive_skills: [] }],
    conditions: [
      {
        water_type: "Salt",
        body_of_water: "Ocean",
        weather: "Rainy",
        air_temp: 20,
        surface_water_temp: 20,
        bottom_water_temp: 20,
        visibility: "Low",
        visibility_distance: 4,
        wave_condition: "SmallWaves",
        current: "SomeCurrent",
        surge: "MediumSurge",
      },
    ],
    equipment: [
      {
        suit_type: "FullSuit_7mm",
        weight: 6,
        weight_type: "Good",
        additional_equipment: ["Hood", "Boots"],
        cylinder_type: "Steel",
        cylinder_size: 14,
        gas_mixture: "Air",
        oxygen: 21,
        nitrogen: 79,
        helium: 0,
        starting_pressure: 185,
        ending_pressure: 94,
      },
    ],
    experiences: [{ feeling: "Average", notes: "test dive", buddies: "Alexei", dive_center: "Aquabubblemakerclub" }],
    ...overrides,
  };
}

// A small fixed logbook (3 dives, ids 1001-1003) -- fewer than the page size, so
// syncPadiLogbook's pagination loop fetches exactly one page and stops. `locations` optionally
// gives each id its own dive_location; ids not listed default to "Den Osse Haven".
function makeFakeClient(
  ids: number[],
  locations: Record<number, string> = {},
  detailOverrides: Record<number, Record<string, unknown>> = {},
) {
  let pageCalls = 0;
  let detailCalls = 0;
  const locationOf = (id: number) => locations[id] ?? "Den Osse Haven";

  return {
    client: {
      async fetchLogbookPage(_accessToken: string, _affiliateId: string | number, { offset }: { limit?: number; offset?: number }) {
        pageCalls += 1;
        if ((offset ?? 0) > 0) return { data: { logbook_logs: [] } };
        return { data: { logbook_logs: ids.map((id) => padiSummary(id, locationOf(id), detailOverrides[id])) } };
      },
      async fetchLogbookDetail(_accessToken: string, _affiliateId: string | number, id: string | number) {
        detailCalls += 1;
        return { data: { logbook_logs: [padiDetail(Number(id), locationOf(Number(id)), detailOverrides[Number(id)])] } };
      },
    },
    calls: () => ({ pageCalls, detailCalls }),
  };
}

async function notificationCount(recipientEmail: string) {
  const result = await getTestPool().query(
    "select count(*)::int as count from notification_queue where recipient_email = $1",
    [recipientEmail],
  );
  return result.rows[0].count as number;
}

async function diveCount(userId: string) {
  const result = await getTestPool().query("select count(*)::int as count from dives where user_id = $1", [userId]);
  return result.rows[0].count as number;
}

async function padiNeedsUpdate(userId: string, padiDiveId: number) {
  const result = await getTestPool().query<{ padi_needs_update: boolean }>(
    "select padi_needs_update from dives where user_id = $1 and padi_dive_id = $2",
    [userId, padiDiveId],
  );
  return result.rows[0]?.padi_needs_update ?? null;
}

// This file's users have status='connected' padi_integrations rows, which
// tests/integration/padi-token-refresh.test.mjs's decrypt-classification tests would otherwise pick
// up as leftover "due" rows (encrypted under this file's own throwaway key, not that file's) --
// see the same pollution issue and fix in that file. Purge before and after this file's own tests.
async function purgeOwnUsers() {
  await getTestPool().query("delete from users where email like 'padi-sync-%@example.com'");
}

beforeAll(async () => {
  process.env.PADI_TOKEN_ENCRYPTION_KEY = TEST_KEY_BASE64;
  await purgeOwnUsers();
});

afterAll(async () => {
  await purgeOwnUsers();
  await closeTestPool();
});

describe("syncPadiLogbook", () => {
  it("imports every dive in a fresh logbook and enqueues zero dive_backup notifications", async () => {
    const owner = await createConnectedOwner();
    const { client } = makeFakeClient([501001, 501002, 501003]);

    const result = await syncPadiLogbook(owner, { padiClient: client });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.imported).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.needsUpdate).toBe(0);
    expect(result.remaining).toBe(false);

    expect(await diveCount(owner.id)).toBe(3);
    expect(await notificationCount(owner.email)).toBe(0);

    // All 3 fixture dives share the same dive_location ("Den Osse Haven") -- resolveDiveSiteId's
    // name-based reuse must converge them onto one dive_sites row, not three.
    expect((await getDiveStats(owner.id)).distinctSites).toBe(1);
  });

  it("creates a distinct dive site per distinct dive_location, not one collapsed site", async () => {
    const owner = await createConnectedOwner();
    const { client } = makeFakeClient([503001, 503002, 503003], {
      503001: "Blue Hole",
      503002: "Blue Hole",
      503003: "Sharm el Naga",
    });

    const result = await syncPadiLogbook(owner, { padiClient: client });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.imported).toBe(3);

    expect((await getDiveStats(owner.id)).distinctSites).toBe(2);
  });

  it("does not duplicate dives on a second sync of the same logbook", async () => {
    const owner = await createConnectedOwner();
    const { client } = makeFakeClient([502001, 502002]);

    await syncPadiLogbook(owner, { padiClient: client });
    const second = await syncPadiLogbook(owner, { padiClient: client });

    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unreachable");
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(2);
    expect(second.needsUpdate).toBe(0);

    expect(await diveCount(owner.id)).toBe(2);
  });

  it("marks an already-linked recreational dive when local fields differ from fetched PADI detail", async () => {
    const owner = await createConnectedOwner();
    const padiDiveId = 502101;
    const { client } = makeFakeClient([padiDiveId]);

    await syncPadiLogbook(owner, { padiClient: client });
    await getTestPool().query(
      "update dives set title = 'Local title changed', padi_needs_update = false where user_id = $1 and padi_dive_id = $2",
      [owner.id, padiDiveId],
    );

    const second = await syncPadiLogbook(owner, { padiClient: client });

    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unreachable");
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.needsUpdate).toBe(1);
    expect(await padiNeedsUpdate(owner.id, padiDiveId)).toBe(true);
  });

  it("does not mark already-linked training/course dives as updateable even when they differ", async () => {
    const owner = await createConnectedOwner();
    const padiDiveId = 502102;
    const { client } = makeFakeClient(
      [padiDiveId],
      {},
      { [padiDiveId]: { log_type: "Course", log_course: "Open Water Diver" } },
    );

    await syncPadiLogbook(owner, { padiClient: client });
    await getTestPool().query(
      "update dives set title = 'Local title changed', padi_needs_update = false where user_id = $1 and padi_dive_id = $2",
      [owner.id, padiDiveId],
    );

    const second = await syncPadiLogbook(owner, { padiClient: client });

    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unreachable");
    expect(second.needsUpdate).toBe(0);
    expect(await padiNeedsUpdate(owner.id, padiDiveId)).toBe(false);
  });

  it("returns 'Sync already in progress' for a concurrent call instead of hanging or double-importing", async () => {
    const owner = await createConnectedOwner();
    // A slow fake client holds the lock for the duration of both concurrent calls.
    let releaseFirstCall: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirstCall = resolve;
    });

    const slowClient = {
      async fetchLogbookPage() {
        await gate;
        return { data: { logbook_logs: [] } };
      },
      async fetchLogbookDetail() {
        return { data: { logbook_logs: [] } };
      },
    };

    const firstCall = syncPadiLogbook(owner, { padiClient: slowClient });
    // Give the first call a moment to acquire the lock before firing the second.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = await syncPadiLogbook(owner, { padiClient: slowClient });
    expect(second).toEqual({ ok: false, error: "Sync already in progress", reason: "in_progress" });

    releaseFirstCall();
    const first = await firstCall;
    expect(first.ok).toBe(true);
  });

  it("returns not_connected when the user has no padi_integrations row", async () => {
    const email = `padi-sync-none-${randomUUID()}@example.com`;
    const userResult = await getTestPool().query<{ id: number }>(
      "insert into users (email, password_hash) values ($1, 'x') returning id",
      [email],
    );
    const owner = { id: String(userResult.rows[0].id), email };

    const result = await syncPadiLogbook(owner, { padiClient: makeFakeClient([]).client });
    expect(result).toEqual({ ok: false, error: "PADI is not connected", reason: "not_connected" });
  });

  it("returns reconnect_required when the integration status is needs_reconnect", async () => {
    const owner = await createConnectedOwner();
    await getTestPool().query("update padi_integrations set status = 'needs_reconnect' where user_id = $1", [
      owner.id,
    ]);

    const result = await syncPadiLogbook(owner, { padiClient: makeFakeClient([]).client });
    expect(result).toEqual({ ok: false, error: "PADI needs to be reconnected", reason: "reconnect_required" });
  });
});
