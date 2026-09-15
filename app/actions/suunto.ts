"use server";

import { revalidatePath } from "next/cache";
import pg from "pg";

import { getDatabaseUrl } from "@/lib/database-url";
import { createDiveFromSuuntoImport, mergeSuuntoImportIntoDive, type DiveInput } from "@/lib/dives";
import {
  assertSuuntoIntegrationConfigured,
  deleteSuuntoIntegration,
  getSuuntoSessionJson,
  hashSuuntoEmail,
  markSuuntoFetched,
  markSuuntoNeedsReconnect,
  saveSuuntoIntegration,
} from "@/lib/suunto/integrations";
import {
  countPendingSuuntoImports,
  deleteSuuntoImport,
  getSuuntoDuplicateStatuses,
  getNextPendingSuuntoImportId,
  listPendingSuuntoImports,
  stageSuuntoImport,
} from "@/lib/suunto/imports";
import { compileSuuntoDiveProfile } from "@/lib/suunto/profile";
import {
  exportSuuntoWorkout,
  listSuuntoWorkouts,
  SuuntoSidecarError,
  suuntoLogin,
  type SuuntoWorkoutSummary,
} from "@/lib/suunto/sidecar-client";
import { requireUser } from "@/lib/session";
import {
  checkSuuntoRateLimit,
  isSuuntoRateLimited,
  recordFailedSuuntoAttempt,
} from "@/lib/suunto/rate-limit";
import { withActionTelemetry } from "@/lib/action-otel";

const UNAVAILABLE_ERROR = "Suunto import is temporarily unavailable. Please try again later.";

// Non-blocking advisory lock keyed by a fixed classid, exactly as lib/padi/sync.ts does for PADI --
// distinct from PADI's 84271 so the two features can never block each other. Arbitrary, just needs
// to stay fixed once chosen.
const ADVISORY_LOCK_CLASSID = 84272;

// Wall-time budget for the unbounded "all time" fetch. Deliberately larger than PADI's 45s: a single
// Suunto export can run up to the sidecar's 180s export timeout, so a smaller budget would often
// stage nothing per click. A budget hit is a resumption, not a failure -- the dedupe in
// getSuuntoDuplicateStatuses makes clicking Fetch again pick up exactly where this left off.
// Overridable by env solely so tests can shrink it; production never sets it.
const FETCH_ALL_BUDGET_MS = 90_000;

function fetchAllBudgetMs(): number {
  const override = Number(process.env.SUUNTO_FETCH_ALL_BUDGET_MS);
  // Clamped at both ends so a misconfigured override can neither disable the budget nor stretch it
  // far past what the request itself can survive.
  return Number.isFinite(override) && override > 0
    ? Math.min(override, FETCH_ALL_BUDGET_MS * 4)
    : FETCH_ALL_BUDGET_MS;
}

export type SuuntoActionResult = { ok: true } | { ok: false; error: string };

export type FetchSuuntoRequest = { mode: "days"; daysBack: number } | { mode: "all" };

export type DeleteSuuntoImportActionResult =
  | { ok: true; nextImportId: number | null; pendingCount: number }
  | { ok: false; error: string };

export type FetchSuuntoActionResult =
  | {
      ok: true;
      checked: number;
      staged: number;
      alreadySaved: number;
      alreadyStaged: number;
      skippedNonDives: number;
      failedExports: number;
      pendingCount: number;
      nextImportId: number | null;
      // True only in "all" mode, when the wall-time budget stopped the loop with workouts left to
      // try. The user clicks Fetch again to continue; `mode: "days"` is always false.
      remaining: boolean;
    }
  | { ok: false; error: string; reason?: string };

export type SaveSuuntoImportActionResult =
  | { ok: true; id: number; nextImportId: number | null; pendingCount: number }
  | { ok: false; error: string; reason: "missing_import" | "missing_dive" | "already_saved" | "unknown" };

function revalidateSuuntoPaths(diveId?: number) {
  revalidatePath("/settings/integrations");
  revalidatePath("/dives");
  revalidatePath("/dashboard");
  if (diveId !== undefined) revalidatePath(`/dives/${diveId}`);
}

function workoutKey(workout: SuuntoWorkoutSummary): string | null {
  const candidates = [workout.key, workout.workoutKey, workout.id, workout.workoutId];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
  }
  return null;
}

function startedAt(workout: SuuntoWorkoutSummary, compiledStartedAt: string | null): string | null {
  if (compiledStartedAt) return compiledStartedAt;
  const candidate = workout.startTime ?? workout.startTimeUnix ?? workout.start_time;
  if (typeof candidate === "number") {
    const ms = candidate > 10_000_000_000 ? candidate : candidate * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof candidate === "string" && candidate) {
    const ms = Date.parse(candidate);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  return null;
}

function toUserError(error: unknown): { error: string; reason?: string } {
  if (error instanceof SuuntoSidecarError) {
    if (error.reason === "auth_expired") {
      return { error: "Your Suunto session expired. Reconnect Suunto and try again.", reason: error.reason };
    }
    if (error.reason === "bad_request") {
      return { error: "Suunto request was invalid. Check the form and try again.", reason: error.reason };
    }
    return { error: UNAVAILABLE_ERROR, reason: error.reason };
  }
  return { error: UNAVAILABLE_ERROR };
}

export async function connectSuuntoAction(email: string, password: string): Promise<SuuntoActionResult> {
  const user = await requireUser();

  return withActionTelemetry("connectSuunto", () => user, async () => {
    let emailHash: string;
    try {
      // Validate local storage prerequisites before contacting Suunto with the user's password. If
      // encryption/pepper config is missing, the user cannot fix it by retrying credentials.
      assertSuuntoIntegrationConfigured();
      emailHash = hashSuuntoEmail(email);
    } catch (error) {
      console.error("Suunto connect preflight failed", error);
      return { ok: false, error: UNAVAILABLE_ERROR };
    }

    const rateLimitCheck = await checkSuuntoRateLimit(user.id, emailHash);
    if (isSuuntoRateLimited(rateLimitCheck)) {
      return { ok: false, error: "Too many attempts. Please wait a while before trying again." };
    }

    let login: Awaited<ReturnType<typeof suuntoLogin>>;
    try {
      login = await suuntoLogin(email, password);
    } catch (error) {
      if (error instanceof SuuntoSidecarError && error.reason === "auth_expired") {
        await recordFailedSuuntoAttempt(user.id, email);
        return { ok: false, error: "Could not sign in to Suunto. Check your email and password." };
      }
      return { ok: false, error: toUserError(error).error };
    }

    try {
      await saveSuuntoIntegration(user.id, { email, sessionJson: login.sessionJson });
    } catch (error) {
      console.error("Suunto session save failed", error);
      return { ok: false, error: UNAVAILABLE_ERROR };
    }

    revalidateSuuntoPaths();
    return { ok: true };
  });
}

export async function disconnectSuuntoAction(): Promise<SuuntoActionResult> {
  const user = await requireUser();
  return withActionTelemetry("disconnectSuunto", () => user, async () => {
    await deleteSuuntoIntegration(user.id);
    revalidateSuuntoPaths();
    return { ok: true };
  });
}

type StageWorkoutsResult =
  | { ok: true; counts: FetchCounts; remaining: boolean }
  | { ok: false; error: string; reason?: string };

type FetchCounts = {
  checked: number;
  staged: number;
  alreadySaved: number;
  alreadyStaged: number;
  skippedNonDives: number;
  failedExports: number;
};

/**
 * Dedupes, exports, compiles and stages a listed batch of workouts. Shared verbatim by both fetch
 * modes; `deadline` is null for `mode: "days"` (bounded at 100 workouts by the sidecar, so an
 * unbudgeted loop is fine) and a wall-clock timestamp for `mode: "all"`. The budget is only ever
 * checked *before* starting an export, never mid-export -- an in-flight sidecar call is always
 * allowed to finish, same principle as lib/padi/sync.ts.
 */
async function stageListedWorkouts(
  userId: string,
  sessionJson: string,
  workouts: SuuntoWorkoutSummary[],
  deadline: number | null,
): Promise<StageWorkoutsResult> {
  const counts: FetchCounts = {
    // Incremented per iteration, not pre-seeded with workouts.length: a budget-truncated run must
    // report how many workouts were actually examined, not how many were listed.
    checked: 0,
    staged: 0,
    alreadySaved: 0,
    alreadyStaged: 0,
    skippedNonDives: 0,
    failedExports: 0,
  };
  const keyedWorkouts = workouts.flatMap((workout) => {
    const key = workoutKey(workout);
    return key ? [{ key, workout }] : [];
  });
  const duplicateStatuses = await getSuuntoDuplicateStatuses(
    userId,
    keyedWorkouts.map(({ key }) => key),
  );

  for (const workout of workouts) {
    counts.checked += 1;
    const key = workoutKey(workout);
    if (!key) {
      counts.failedExports += 1;
      continue;
    }
    const duplicateStatus = duplicateStatuses.get(key);
    if (duplicateStatus === "already_saved") {
      counts.alreadySaved += 1;
      continue;
    }
    if (duplicateStatus === "already_staged") {
      counts.alreadyStaged += 1;
      continue;
    }

    // This workout is a real candidate that hasn't been exported yet, so stopping here always
    // leaves work behind -- the caller reports `remaining` so the user knows to fetch again.
    if (deadline !== null && Date.now() > deadline) {
      return { ok: true, counts, remaining: true };
    }

    let exported: Awaited<ReturnType<typeof exportSuuntoWorkout>>;
    try {
      exported = await exportSuuntoWorkout(sessionJson, key);
    } catch (error) {
      if (error instanceof SuuntoSidecarError && error.reason === "auth_expired") {
        await markSuuntoNeedsReconnect(userId);
        const failure = toUserError(error);
        return { ok: false, ...failure };
      }
      if (error instanceof SuuntoSidecarError) {
        counts.failedExports += 1;
        continue;
      }
      console.error("Suunto export failed outside sidecar contract", error);
      return { ok: false, error: UNAVAILABLE_ERROR };
    }

    const compiled = compileSuuntoDiveProfile(key, exported.workoutSmlJson);
    if (!compiled.ok) {
      counts.skippedNonDives += 1;
      continue;
    }

    try {
      const staged = await stageSuuntoImport(userId, {
        workoutKey: key,
        workoutStartedAt: startedAt(workout, compiled.profile.startedAt),
        summary: exported.workoutJson,
        draftDive: compiled.draftDive,
        compiledProfile: compiled.profile,
        originalBundle: Buffer.from(exported.bundleBase64, "base64"),
      });

      if (staged.staged) counts.staged += 1;
      else if (staged.reason === "already_saved") counts.alreadySaved += 1;
      else counts.alreadyStaged += 1;
    } catch (error) {
      console.error("Suunto staging failed", error);
      return { ok: false, error: UNAVAILABLE_ERROR };
    }
  }

  return { ok: true, counts, remaining: false };
}

// Shared tail of both fetch modes: stamp the fetch, re-read the pending queue, revalidate.
async function finishFetch(userId: string, staged: { counts: FetchCounts; remaining: boolean }) {
  await markSuuntoFetched(userId);
  const [pendingCount, pending] = await Promise.all([
    countPendingSuuntoImports(userId),
    listPendingSuuntoImports(userId),
  ]);

  revalidateSuuntoPaths();
  return {
    ok: true as const,
    ...staged.counts,
    remaining: staged.remaining,
    pendingCount,
    nextImportId: pending[0]?.id ?? null,
  };
}

async function listWorkoutsForRequest(
  userId: string,
  sessionJson: string,
  request: FetchSuuntoRequest,
): Promise<{ ok: true; workouts: SuuntoWorkoutSummary[] } | { ok: false; error: string; reason?: string }> {
  try {
    if (request.mode === "all") {
      return { ok: true, ...(await listSuuntoWorkouts(sessionJson, { all: true })) };
    }
    const normalizedDaysBack = Number.isFinite(request.daysBack) ? Math.floor(request.daysBack) : 10;
    const boundedDaysBack = Math.max(1, Math.min(365, normalizedDaysBack));
    return { ok: true, ...(await listSuuntoWorkouts(sessionJson, { daysBack: boundedDaysBack })) };
  } catch (error) {
    if (error instanceof SuuntoSidecarError && error.reason === "auth_expired") {
      await markSuuntoNeedsReconnect(userId);
    }
    return { ok: false, ...toUserError(error) };
  }
}

export async function fetchSuuntoWorkoutsAction(request: FetchSuuntoRequest): Promise<FetchSuuntoActionResult> {
  const user = await requireUser();

  return withActionTelemetry("fetchSuuntoWorkouts", () => user, async () => {
    // Server Action arguments are client-controlled, so the discriminant is validated rather than
    // assumed: without this, anything that isn't "days" would fall through to the expensive unbounded
    // all-time path.
    if (request?.mode !== "days" && request?.mode !== "all") {
      return { ok: false, error: "Unsupported fetch mode.", reason: "bad_request" };
    }

    let sessionJson: string | null;
    try {
      sessionJson = await getSuuntoSessionJson(user.id);
    } catch {
      return { ok: false, error: UNAVAILABLE_ERROR };
    }
    if (!sessionJson) {
      return { ok: false, error: "Connect Suunto before fetching workouts.", reason: "not_connected" };
    }

    if (request.mode === "days") {
      const listed = await listWorkoutsForRequest(user.id, sessionJson, request);
      if (!listed.ok) return listed;

      const staged = await stageListedWorkouts(user.id, sessionJson, listed.workouts, null);
      if (!staged.ok) return staged;
      return finishFetch(user.id, staged);
    }

    // Dedicated, single-use client for the advisory lock -- deliberately not a pooled connection.
    // pg_try_advisory_lock is session-scoped: it lives and dies with this one connection, so closing
    // this client (below, unconditionally) always releases the lock even if the explicit unlock query
    // itself fails. Same shape and rationale as lib/padi/sync.ts's lock.
    const lockClient = new pg.Client({ connectionString: getDatabaseUrl() });
    await lockClient.connect();

    let lockAcquired = false;
    try {
      const lockResult = await lockClient.query<{ pg_try_advisory_lock: boolean }>(
        "select pg_try_advisory_lock($1::int4, $2::int4)",
        [ADVISORY_LOCK_CLASSID, Number(user.id)],
      );
      lockAcquired = lockResult.rows[0]?.pg_try_advisory_lock ?? false;

      if (!lockAcquired) {
        // Scoped wording: the lock only guards mode "all", so a concurrent mode "days" fetch is
        // unaffected and never sees this.
        return { ok: false, error: "An all-time Suunto fetch is already in progress.", reason: "in_progress" };
      }

      // Started before the listing, not after it: the listing alone can run for minutes, and the
      // budget is meant to bound the whole request (and therefore how long this lock is held). If
      // listing already blew it, the staging loop stops at its first real candidate and reports
      // `remaining: true`, which is exactly the "click Fetch again" outcome.
      const deadline = Date.now() + fetchAllBudgetMs();
      const listed = await listWorkoutsForRequest(user.id, sessionJson, request);
      if (!listed.ok) return listed;

      const staged = await stageListedWorkouts(user.id, sessionJson, listed.workouts, deadline);
      if (!staged.ok) return staged;
      return finishFetch(user.id, staged);
    } finally {
      if (lockAcquired) {
        try {
          await lockClient.query("select pg_advisory_unlock($1::int4, $2::int4)", [
            ADVISORY_LOCK_CLASSID,
            Number(user.id),
          ]);
        } catch {
          // Best-effort: the connection closes immediately below regardless, which releases the
          // session-scoped lock either way.
        }
      }
      await lockClient.end();
    }
  });
}

export async function createSuuntoDiveImportAction(
  importId: number,
  input: DiveInput,
): Promise<SaveSuuntoImportActionResult> {
  const user = await requireUser();

  return withActionTelemetry("createSuuntoDiveImport", () => user, async () => {
    try {
      const result = await createDiveFromSuuntoImport(user, importId, input);
      if (!result.inserted) {
        return {
          ok: false,
          reason: result.reason,
          error:
            result.reason === "already_saved"
              ? "This Suunto workout was already saved. Delete the saved dive before importing it again."
              : "That Suunto import is no longer available.",
        };
      }

      const [pendingCount, pending] = await Promise.all([
        countPendingSuuntoImports(user.id),
        listPendingSuuntoImports(user.id),
      ]);
      revalidateSuuntoPaths(result.dive.id);
      return { ok: true, id: result.dive.id, pendingCount, nextImportId: pending[0]?.id ?? null };
    } catch (error) {
      console.error("Suunto import save failed", error);
      return { ok: false, error: "Something went wrong. Please try again.", reason: "unknown" };
    }
  });
}

export async function mergeSuuntoDiveImportAction(
  importId: number,
  targetDiveId: number,
  input: DiveInput,
): Promise<SaveSuuntoImportActionResult> {
  const user = await requireUser();

  return withActionTelemetry("mergeSuuntoDiveImport", () => user, async () => {
    try {
      const result = await mergeSuuntoImportIntoDive(user, importId, targetDiveId, input);
      if (!result.merged) {
        return {
          ok: false,
          reason: result.reason,
          error:
            result.reason === "already_saved"
              ? "This Suunto workout was already saved. Delete the saved dive before importing it again."
              : result.reason === "missing_dive"
                ? "That target dive is no longer available."
                : "That Suunto import is no longer available.",
        };
      }

      const [pendingCount, pending] = await Promise.all([
        countPendingSuuntoImports(user.id),
        listPendingSuuntoImports(user.id),
      ]);
      revalidateSuuntoPaths(result.dive.id);
      return { ok: true, id: result.dive.id, pendingCount, nextImportId: pending[0]?.id ?? null };
    } catch (error) {
      console.error("Suunto import merge failed", error);
      return { ok: false, error: "Something went wrong. Please try again.", reason: "unknown" };
    }
  });
}

export async function deleteSuuntoImportAction(importId: number): Promise<DeleteSuuntoImportActionResult> {
  const user = await requireUser();

  return withActionTelemetry("deleteSuuntoImport", () => user, async () => {
    const nextBeforeDelete = await getNextPendingSuuntoImportId(user.id, importId);
    const deleted = await deleteSuuntoImport(user.id, importId);

    if (!deleted) {
      return { ok: false, error: "That Suunto import is no longer available." };
    }

    const pendingCount = await countPendingSuuntoImports(user.id);
    const nextImportId =
      nextBeforeDelete ?? (pendingCount > 0 ? (await listPendingSuuntoImports(user.id))[0]?.id ?? null : null);

    revalidatePath("/settings/integrations");
    revalidatePath(`/settings/integrations/suunto/imports/${importId}`);
    if (nextImportId !== null) revalidatePath(`/settings/integrations/suunto/imports/${nextImportId}`);
    return { ok: true, nextImportId, pendingCount };
  });
}
