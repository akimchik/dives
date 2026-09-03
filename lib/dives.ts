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
  occurred_at: Date;
  max_depth: string | null;
  avg_depth: string | null;
  bottom_time_minutes: number | null;
  water_temp: string | null;
  visibility: string | null;
  gas_mix: string | null;
  tank_info: string | null;
  weight: string | null;
  suit_type: string | null;
  buddy: string | null;
  dive_shop: string | null;
  current: string | null;
  surge: string | null;
  weather: string | null;
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
  occurredAt: Date | string;
  maxDepth: number | null;
  avgDepth: number | null;
  bottomTimeMinutes: number | null;
  waterTemp: number | null;
  visibility: number | null;
  gasMix: string | null;
  tankInfo: string | null;
  weight: number | null;
  suitType: string | null;
  buddy: string | null;
  diveShop: string | null;
  current: string | null;
  surge: string | null;
  weather: string | null;
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
  d.occurred_at,
  d.max_depth,
  d.avg_depth,
  d.bottom_time_minutes,
  d.water_temp,
  d.visibility,
  d.gas_mix,
  d.tank_info,
  d.weight,
  d.suit_type,
  d.buddy,
  d.dive_shop,
  d.current,
  d.surge,
  d.weather,
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
    input.occurredAt,
    input.maxDepth,
    input.avgDepth,
    input.bottomTimeMinutes,
    input.waterTemp,
    input.visibility,
    input.gasMix,
    input.tankInfo,
    input.weight,
    input.suitType,
    input.buddy,
    input.diveShop,
    input.current,
    input.surge,
    input.weather,
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
          user_id, dive_site_id, occurred_at, max_depth, avg_depth, bottom_time_minutes,
          water_temp, visibility, gas_mix, tank_info, weight, suit_type, buddy, dive_shop,
          current, surge, weather, entry_type, notes, rating, depth_profile, depth_profile_raw
        )
        values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
          $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
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
          occurred_at = $4,
          max_depth = $5,
          avg_depth = $6,
          bottom_time_minutes = $7,
          water_temp = $8,
          visibility = $9,
          gas_mix = $10,
          tank_info = $11,
          weight = $12,
          suit_type = $13,
          buddy = $14,
          dive_shop = $15,
          current = $16,
          surge = $17,
          weather = $18,
          entry_type = $19,
          notes = $20,
          rating = $21,
          depth_profile = $22,
          depth_profile_raw = $23,
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
