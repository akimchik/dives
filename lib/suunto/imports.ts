import "server-only";

import { getPool, queryRead } from "@/lib/db";
import type { DiveInput } from "@/lib/dives";
import type { SuuntoDiveProfile } from "./profile";

export type SuuntoImportRow = {
  id: number;
  workout_key: string;
  workout_started_at: Date | null;
  summary: unknown;
  draft_dive: Partial<DiveInput>;
  compiled_profile: SuuntoDiveProfile;
  created_at: Date;
};

export type StageSuuntoImportInput = {
  workoutKey: string;
  workoutStartedAt: string | Date | null;
  summary: unknown;
  draftDive: Partial<DiveInput>;
  compiledProfile: SuuntoDiveProfile;
  originalBundle: Buffer;
};

export type StageSuuntoImportResult =
  | { staged: true; id: number }
  | { staged: false; reason: "already_staged" | "already_saved" };

export type SuuntoDuplicateStatus = "new" | "already_staged" | "already_saved";

export async function stageSuuntoImport(
  userId: string,
  input: StageSuuntoImportInput,
): Promise<StageSuuntoImportResult> {
  const result = await getPool().query<{ id: number }>(
    `
      insert into suunto_imports
        (user_id, workout_key, workout_started_at, summary, draft_dive, compiled_profile, original_bundle, updated_at)
      select $1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, now()
      where not exists (
        select 1 from dives where user_id = $1 and suunto_workout_key = $2
      )
      on conflict (user_id, workout_key) do nothing
      returning id
    `,
    [
      userId,
      input.workoutKey,
      input.workoutStartedAt,
      JSON.stringify(input.summary ?? {}),
      JSON.stringify(input.draftDive ?? {}),
      JSON.stringify(input.compiledProfile),
      input.originalBundle,
    ],
  );

  if (result.rows[0]) return { staged: true, id: result.rows[0].id };

  const saved = await queryRead<{ exists: boolean }>(
    "select exists(select 1 from dives where user_id = $1 and suunto_workout_key = $2) as exists",
    [userId, input.workoutKey],
  );
  return { staged: false, reason: saved.rows[0]?.exists ? "already_saved" : "already_staged" };
}

export async function getSuuntoDuplicateStatuses(
  userId: string,
  workoutKeys: string[],
): Promise<Map<string, SuuntoDuplicateStatus>> {
  const uniqueKeys = [...new Set(workoutKeys.filter((key) => key.trim()))];
  const statuses = new Map<string, SuuntoDuplicateStatus>();
  for (const key of uniqueKeys) statuses.set(key, "new");
  if (uniqueKeys.length === 0) return statuses;

  const result = await queryRead<{ workout_key: string; status: Exclude<SuuntoDuplicateStatus, "new"> }>(
    `
      select suunto_workout_key as workout_key, 'already_saved'::text as status
      from dives
      where user_id = $1
        and suunto_workout_key = any($2::text[])
      union all
      select workout_key, 'already_staged'::text as status
      from suunto_imports
      where user_id = $1
        and workout_key = any($2::text[])
    `,
    [userId, uniqueKeys],
  );

  for (const row of result.rows) {
    if (statuses.get(row.workout_key) === "already_saved") continue;
    statuses.set(row.workout_key, row.status);
  }

  return statuses;
}

export async function getFirstPendingSuuntoImportId(userId: string): Promise<number | null> {
  const result = await queryRead<{ id: number }>(
    `
      select id
      from suunto_imports
      where user_id = $1
      order by coalesce(workout_started_at, created_at) asc, id asc
      limit 1
    `,
    [userId],
  );
  return result.rows[0]?.id ?? null;
}

export async function getNextPendingSuuntoImportId(userId: string, currentImportId: number): Promise<number | null> {
  const result = await queryRead<{ id: number }>(
    `
      with ordered as (
        select
          id,
          row_number() over (order by coalesce(workout_started_at, created_at) asc, id asc) as position
        from suunto_imports
        where user_id = $1
      ),
      current_position as (
        select position from ordered where id = $2
      )
      select ordered.id
      from ordered
      cross join current_position
      where ordered.position > current_position.position
      order by ordered.position asc
      limit 1
    `,
    [userId, currentImportId],
  );
  return result.rows[0]?.id ?? null;
}

export async function countPendingSuuntoImports(userId: string): Promise<number> {
  const result = await queryRead<{ count: string }>(
    "select count(*) as count from suunto_imports where user_id = $1",
    [userId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function listPendingSuuntoImports(userId: string): Promise<SuuntoImportRow[]> {
  const result = await queryRead<SuuntoImportRow>(
    `
      select id, workout_key, workout_started_at, summary, draft_dive, compiled_profile, created_at
      from suunto_imports
      where user_id = $1
      order by coalesce(workout_started_at, created_at) asc, id asc
    `,
    [userId],
  );
  return result.rows;
}

export async function getPendingSuuntoImport(
  userId: string,
  importId: number,
): Promise<(SuuntoImportRow & { remaining_count: number }) | null> {
  const result = await queryRead<SuuntoImportRow & { remaining_count: string }>(
    `
      with pending as (
        select id, workout_key, workout_started_at, summary, draft_dive, compiled_profile, created_at
        from suunto_imports
        where user_id = $1
      )
      select pending.*, counts.remaining_count
      from pending
      cross join (select count(*)::int as remaining_count from pending) counts
      where pending.id = $2
      limit 1
    `,
    [userId, importId],
  );

  const row = result.rows[0];
  if (!row) return null;
  return { ...row, remaining_count: Number(row.remaining_count) };
}

export async function deleteSuuntoImport(userId: string, importId: number): Promise<boolean> {
  const result = await getPool().query("delete from suunto_imports where id = $1 and user_id = $2", [
    importId,
    userId,
  ]);
  return (result.rowCount ?? 0) > 0;
}
