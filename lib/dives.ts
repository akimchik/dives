import "server-only";

import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { getPool, queryRead } from "./db";
import { enqueueNotification } from "./notification-queue";

// Every query in this module takes the session user's id and filters on it. A dive/site id coming
// from a URL or a form is never trusted on its own: a mutation scoped by `user_id` that matches no
// row throws DiveNotFoundError, so another user's row is never read, updated or deleted (AGENTS.md's
// per-user ownership rule).
export class DiveNotFoundError extends Error {
  constructor(message = "Dive not found") {
    super(message);
    this.name = "DiveNotFoundError";
  }
}

export class DiveSiteNotFoundError extends Error {
  constructor(message = "Dive site not found") {
    super(message);
    this.name = "DiveSiteNotFoundError";
  }
}

export type DiveSiteRow = {
  id: number;
  name: string;
  location: string | null;
  lat: number | null;
  lng: number | null;
  created_at: Date;
};

// The dive_backup payload contract (scripts/notifications/templates.mjs's renderDiveBackupEmail and
// queue.mjs's buildDiveBackupAttachments): a FLAT column snapshot. The site is flattened into
// site_name/site_location/site_lat/site_lng rather than nested, because the CSV attachment writes
// one cell per key and JSON-stringifies any nested object into it.
export type DiveSnapshot = {
  id: number;
  title: string | null;
  occurred_at: Date;
  max_depth: string | null;
  avg_depth: string | null;
  bottom_time_minutes: number | null;
  water_temp: string | null;
  water_temp_low: string | null;
  air_temp: string | null;
  visibility: string | null;
  gas_mix: string | null;
  tank_info: string | null;
  cylinder_size: string | null;
  start_pressure: string | null;
  end_pressure: string | null;
  weight: string | null;
  weight_feedback: string | null;
  suit_type: string | null;
  hood: boolean | null;
  gloves: boolean | null;
  boots: boolean | null;
  buddy: string | null;
  dive_shop: string | null;
  current: string | null;
  surge: string | null;
  waves: string | null;
  weather: string | null;
  water_type: string | null;
  body_of_water: string | null;
  entry_type: string | null;
  notes: string | null;
  rating: number | null;
  depth_profile: unknown;
  depth_profile_raw: string | null;
  created_at: Date;
  updated_at: Date;
  site_name: string | null;
  site_location: string | null;
  site_lat: number | null;
  site_lng: number | null;
};

// Reads for the UI additionally need the raw foreign key (the edit form preselects the site);
// the backup payload deliberately doesn't carry it -- the flattened site_* fields are the snapshot.
export type DiveRecord = DiveSnapshot & { dive_site_id: number | null };

// A dive's site is either one the user already picked from their own autocomplete list, or a name
// typed into it that may or may not exist yet -- resolved inside the mutation's own transaction so a
// rolled-back dive write can't leave an orphaned site behind.
type DiveSiteSelection =
  | { id: number }
  | { name: string; location?: string | null; lat?: number | null; lng?: number | null };

export type DiveInput = {
  site: DiveSiteSelection | null;
  title: string | null;
  occurredAt: Date | string;
  maxDepth: number | null;
  avgDepth: number | null;
  bottomTimeMinutes: number | null;
  waterTemp: number | null;
  waterTempLow: number | null;
  airTemp: number | null;
  visibility: number | null;
  gasMix: string | null;
  tankInfo: string | null;
  cylinderSize: number | null;
  startPressure: number | null;
  endPressure: number | null;
  weight: number | null;
  weightFeedback: string | null;
  suitType: string | null;
  hood: boolean | null;
  gloves: boolean | null;
  boots: boolean | null;
  buddy: string | null;
  diveShop: string | null;
  current: string | null;
  surge: string | null;
  waves: string | null;
  weather: string | null;
  waterType: string | null;
  bodyOfWater: string | null;
  entryType: string | null;
  notes: string | null;
  rating: number | null;
  depthProfile: unknown;
  depthProfileRaw: string | null;
};

type DiveEvent = "create" | "edit" | "delete";

export type DiveOwner = { id: string; email: string };

const snapshotColumns = `
  d.id,
  d.title,
  d.occurred_at,
  d.max_depth,
  d.avg_depth,
  d.bottom_time_minutes,
  d.water_temp,
  d.water_temp_low,
  d.air_temp,
  d.visibility,
  d.gas_mix,
  d.tank_info,
  d.cylinder_size,
  d.start_pressure,
  d.end_pressure,
  d.weight,
  d.weight_feedback,
  d.suit_type,
  d.hood,
  d.gloves,
  d.boots,
  d.buddy,
  d.dive_shop,
  d.current,
  d.surge,
  d.waves,
  d.weather,
  d.water_type,
  d.body_of_water,
  d.entry_type,
  d.notes,
  d.rating,
  d.depth_profile,
  d.depth_profile_raw,
  d.created_at,
  d.updated_at,
  s.name as site_name,
  s.location as site_location,
  s.lat as site_lat,
  s.lng as site_lng
`;

// The join is scoped by user_id on both sides: even if a dive somehow referenced a foreign site,
// its details would not be readable here.
const diveFrom = `
  from dives d
  left join dive_sites s on s.id = d.dive_site_id and s.user_id = d.user_id
`;

function diveValues(diveSiteId: number | null, input: DiveInput) {
  return [
    diveSiteId,
    input.title,
    input.occurredAt,
    input.maxDepth,
    input.avgDepth,
    input.bottomTimeMinutes,
    input.waterTemp,
    input.waterTempLow,
    input.airTemp,
    input.visibility,
    input.gasMix,
    input.tankInfo,
    input.cylinderSize,
    input.startPressure,
    input.endPressure,
    input.weight,
    input.weightFeedback,
    input.suitType,
    input.hood,
    input.gloves,
    input.boots,
    input.buddy,
    input.diveShop,
    input.current,
    input.surge,
    input.waves,
    input.weather,
    input.waterType,
    input.bodyOfWater,
    input.entryType,
    input.notes,
    input.rating,
    input.depthProfile === null || input.depthProfile === undefined
      ? null
      : JSON.stringify(input.depthProfile),
    input.depthProfileRaw,
  ];
}

// ---------------------------------------------------------------------------
// Dive sites
// ---------------------------------------------------------------------------

// Autocomplete source for the dive form. Only ever the session user's own sites -- there is no
// shared cross-user site directory in v1.
export async function listDiveSites(userId: string, query?: string): Promise<DiveSiteRow[]> {
  const result = await queryRead<DiveSiteRow>(
    `
      select id, name, location, lat, lng, created_at
      from dive_sites
      where user_id = $1
        and ($2::text is null or name ilike '%' || $2 || '%')
      order by name asc
      limit 50
    `,
    [userId, query?.trim() ? query.trim() : null],
  );

  return result.rows;
}

// Create-or-reuse for the form's site autocomplete: an existing site of this user with the same
// (case-insensitive) name is reused rather than duplicated. Takes an optional client so the site
// can be created inside the dive's own transaction -- a rolled-back dive write must not leave an
// orphaned site behind.
export async function findOrCreateDiveSite(
  userId: string,
  input: { name: string; location?: string | null; lat?: number | null; lng?: number | null },
  client?: PoolClient,
): Promise<DiveSiteRow> {
  const name = input.name.trim();

  if (!name) {
    throw new Error("Dive site name is required.");
  }

  const executor = client ?? getPool();

  const existing = await executor.query<DiveSiteRow>(
    `
      select id, name, location, lat, lng, created_at
      from dive_sites
      where user_id = $1
        and lower(name) = lower($2)
      limit 1
    `,
    [userId, name],
  );

  if (existing.rows[0]) {
    return existing.rows[0];
  }

  const created = await executor.query<DiveSiteRow>(
    `
      insert into dive_sites (user_id, name, location, lat, lng)
      values ($1, $2, $3, $4, $5)
      returning id, name, location, lat, lng, created_at
    `,
    [userId, name, input.location ?? null, input.lat ?? null, input.lng ?? null],
  );

  return created.rows[0];
}

// A site id from a form is never trusted: one belonging to another user resolves to not-found
// rather than silently attaching that user's site to this dive.
async function resolveDiveSiteId(
  client: PoolClient,
  userId: string,
  site: DiveSiteSelection | null,
): Promise<number | null> {
  if (!site) return null;

  if ("id" in site) {
    const result = await client.query(
      "select id from dive_sites where id = $1 and user_id = $2 limit 1",
      [site.id, userId],
    );

    if (result.rowCount === 0) {
      throw new DiveSiteNotFoundError();
    }

    return site.id;
  }

  return (await findOrCreateDiveSite(userId, site, client)).id;
}

// ---------------------------------------------------------------------------
// Dive reads
// ---------------------------------------------------------------------------

export async function listDives(userId: string): Promise<DiveRecord[]> {
  const result = await queryRead<DiveRecord>(
    `
      select ${snapshotColumns}, d.dive_site_id
      ${diveFrom}
      where d.user_id = $1
      order by d.occurred_at desc, d.id desc
    `,
    [userId],
  );

  return result.rows;
}

// Returns null (never another user's row) when the id belongs to somebody else -- callers render
// not-found from that.
export async function getDive(userId: string, diveId: number): Promise<DiveRecord | null> {
  const result = await queryRead<DiveRecord>(
    `
      select ${snapshotColumns}, d.dive_site_id
      ${diveFrom}
      where d.id = $1
        and d.user_id = $2
      limit 1
    `,
    [diveId, userId],
  );

  return result.rows[0] ?? null;
}

export type RecentCylinder = {
  tankInfo: string | null;
  cylinderSize: string | null;
};

// The form's optional "recent cylinder" picker: the user's last 5 distinct (tank_info,
// cylinder_size) combinations, ordered by the most recent dive that used each one -- not by
// creation order, so editing an old dive's gear doesn't reorder the list. Rows where the user
// recorded neither field are excluded; there's nothing to offer for those.
export async function listRecentCylinders(userId: string): Promise<RecentCylinder[]> {
  const result = await queryRead<{ tank_info: string | null; cylinder_size: string | null }>(
    `
      select tank_info, cylinder_size
      from (
        select
          tank_info,
          cylinder_size,
          max(occurred_at) as last_used_at
        from dives
        where user_id = $1
          and (tank_info is not null or cylinder_size is not null)
        group by tank_info, cylinder_size
      ) recent
      order by last_used_at desc
      limit 5
    `,
    [userId],
  );

  return result.rows.map((row) => ({ tankInfo: row.tank_info, cylinderSize: row.cylinder_size }));
}

// GitHub-style activity calendar (dashboard): dive counts per day, grouped in SQL rather than
// aggregated client-side over the full dive list, since only the count and date leave the query.
export type DailyDiveCount = { date: string; count: number };

export async function getDiveActivityByDay(
  userId: string,
  range: { from: Date; to: Date },
): Promise<DailyDiveCount[]> {
  const result = await queryRead<{ date: string; count: string }>(
    `
      select to_char(occurred_at, 'YYYY-MM-DD') as date, count(*) as count
      from dives
      where user_id = $1
        and occurred_at >= $2
        and occurred_at < $3
      group by 1
      order by 1 asc
    `,
    [userId, range.from, range.to],
  );

  return result.rows.map((row) => ({ date: row.date, count: Number(row.count) }));
}

// Bounds the activity calendar's "All" range selector -- how far back it needs to fetch data
// depends on when the user's logbook actually starts, not a fixed window.
export async function getEarliestDiveDate(userId: string): Promise<Date | null> {
  const result = await queryRead<{ earliest: string | null }>(
    `select min(occurred_at) as earliest from dives where user_id = $1`,
    [userId],
  );

  const earliest = result.rows[0]?.earliest;
  return earliest ? new Date(earliest) : null;
}

export type DiveStats = {
  totalDives: number;
  totalBottomTimeMinutes: number;
  deepestDepth: string | null;
  distinctSites: number;
};

export async function getDiveStats(userId: string): Promise<DiveStats> {
  const result = await queryRead<{
    total_dives: string;
    total_bottom_time_minutes: string | null;
    deepest_depth: string | null;
    distinct_sites: string;
  }>(
    `
      select
        count(*) as total_dives,
        coalesce(sum(bottom_time_minutes), 0) as total_bottom_time_minutes,
        max(max_depth) as deepest_depth,
        count(distinct dive_site_id) as distinct_sites
      from dives
      where user_id = $1
    `,
    [userId],
  );

  const row = result.rows[0];

  return {
    totalDives: Number(row?.total_dives ?? 0),
    totalBottomTimeMinutes: Number(row?.total_bottom_time_minutes ?? 0),
    deepestDepth: row?.deepest_depth ?? null,
    distinctSites: Number(row?.distinct_sites ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Dive mutations (each one write + enqueue in a single transaction)
// ---------------------------------------------------------------------------

async function loadSnapshot(
  client: PoolClient,
  userId: string,
  diveId: number,
): Promise<DiveSnapshot> {
  const result = await client.query<DiveSnapshot>(
    `
      select ${snapshotColumns}
      ${diveFrom}
      where d.id = $1
        and d.user_id = $2
      limit 1
    `,
    [diveId, userId],
  );

  const row = result.rows[0];

  if (!row) {
    throw new DiveNotFoundError();
  }

  return row;
}

// Each invocation gets its own UUID: two consecutive edits of the same dive must produce two
// distinct outbox rows, not one collapsed row (enqueueNotification dedupes on idempotency_key).
function backupKey(diveId: number, event: DiveEvent) {
  return `dive-backup:${diveId}:${event}:${randomUUID()}`;
}

async function enqueueDiveBackup(
  client: PoolClient,
  owner: DiveOwner,
  event: DiveEvent,
  dive: DiveSnapshot,
) {
  await enqueueNotification(
    {
      recipientEmail: owner.email,
      notificationType: "dive_backup",
      idempotencyKey: backupKey(dive.id, event),
      payload: { event, dive },
    },
    { client },
  );
}

// Mirrors the manual-transaction pattern used by the rest of this repo's write paths: connect,
// BEGIN, write, COMMIT, release in a finally. The backup enqueue shares this client, so a dive can
// never be written without its backup notification (or vice versa).
async function inTransaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();

  try {
    await client.query("begin");
    const result = await run(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function createDive(owner: DiveOwner, input: DiveInput): Promise<DiveSnapshot> {
  return inTransaction(async (client) => {
    const diveSiteId = await resolveDiveSiteId(client, owner.id, input.site);

    const inserted = await client.query<{ id: number }>(
      `
        insert into dives (
          user_id, dive_site_id, title, occurred_at, max_depth, avg_depth, bottom_time_minutes,
          water_temp, water_temp_low, air_temp, visibility, gas_mix, tank_info, cylinder_size,
          start_pressure, end_pressure, weight, weight_feedback, suit_type, hood, gloves, boots,
          buddy, dive_shop, current, surge, waves, weather, water_type, body_of_water,
          entry_type, notes, rating, depth_profile, depth_profile_raw
        )
        values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
          $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35
        )
        returning id
      `,
      [owner.id, ...diveValues(diveSiteId, input)],
    );

    const snapshot = await loadSnapshot(client, owner.id, inserted.rows[0].id);
    await enqueueDiveBackup(client, owner, "create", snapshot);

    return snapshot;
  });
}

export async function updateDive(
  owner: DiveOwner,
  diveId: number,
  input: DiveInput,
): Promise<DiveSnapshot> {
  return inTransaction(async (client) => {
    const diveSiteId = await resolveDiveSiteId(client, owner.id, input.site);

    const updated = await client.query(
      `
        update dives set
          dive_site_id = $3,
          title = $4,
          occurred_at = $5,
          max_depth = $6,
          avg_depth = $7,
          bottom_time_minutes = $8,
          water_temp = $9,
          water_temp_low = $10,
          air_temp = $11,
          visibility = $12,
          gas_mix = $13,
          tank_info = $14,
          cylinder_size = $15,
          start_pressure = $16,
          end_pressure = $17,
          weight = $18,
          weight_feedback = $19,
          suit_type = $20,
          hood = $21,
          gloves = $22,
          boots = $23,
          buddy = $24,
          dive_shop = $25,
          current = $26,
          surge = $27,
          waves = $28,
          weather = $29,
          water_type = $30,
          body_of_water = $31,
          entry_type = $32,
          notes = $33,
          rating = $34,
          depth_profile = $35,
          depth_profile_raw = $36,
          updated_at = now()
        where id = $1
          and user_id = $2
      `,
      [diveId, owner.id, ...diveValues(diveSiteId, input)],
    );

    // Fails closed: a dive id belonging to another user matches no row here, so the update is a
    // no-op and this throws instead of reporting success.
    if (updated.rowCount === 0) {
      throw new DiveNotFoundError();
    }

    const snapshot = await loadSnapshot(client, owner.id, diveId);
    await enqueueDiveBackup(client, owner, "edit", snapshot);

    return snapshot;
  });
}

export async function deleteDive(owner: DiveOwner, diveId: number): Promise<DiveSnapshot> {
  return inTransaction(async (client) => {
    // Snapshot first: once the row is gone the worker draining the queue later has no way to
    // re-read it, so the payload captured here is the only copy the backup email can be built from.
    const snapshot = await loadSnapshot(client, owner.id, diveId);

    const deleted = await client.query("delete from dives where id = $1 and user_id = $2", [
      diveId,
      owner.id,
    ]);

    if (deleted.rowCount === 0) {
      throw new DiveNotFoundError();
    }

    await enqueueDiveBackup(client, owner, "delete", snapshot);

    return snapshot;
  });
}
