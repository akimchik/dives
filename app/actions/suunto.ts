"use server";

import { revalidatePath } from "next/cache";

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

const UNAVAILABLE_ERROR = "Suunto import is temporarily unavailable. Please try again later.";

export type SuuntoActionResult = { ok: true } | { ok: false; error: string };

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
}

export async function disconnectSuuntoAction(): Promise<SuuntoActionResult> {
  const user = await requireUser();
  await deleteSuuntoIntegration(user.id);
  revalidateSuuntoPaths();
  return { ok: true };
}

export async function fetchSuuntoWorkoutsAction(daysBack: number): Promise<FetchSuuntoActionResult> {
  const user = await requireUser();
  const normalizedDaysBack = Number.isFinite(daysBack) ? Math.floor(daysBack) : 10;
  const boundedDaysBack = Math.max(1, Math.min(365, normalizedDaysBack));

  let sessionJson: string | null;
  try {
    sessionJson = await getSuuntoSessionJson(user.id);
  } catch {
    return { ok: false, error: UNAVAILABLE_ERROR };
  }
  if (!sessionJson) {
    return { ok: false, error: "Connect Suunto before fetching workouts.", reason: "not_connected" };
  }

  let workouts: SuuntoWorkoutSummary[];
  try {
    ({ workouts } = await listSuuntoWorkouts(sessionJson, boundedDaysBack));
  } catch (error) {
    if (error instanceof SuuntoSidecarError && error.reason === "auth_expired") {
      await markSuuntoNeedsReconnect(user.id);
    }
    const failure = toUserError(error);
    return { ok: false, ...failure };
  }

  const counts = {
    checked: workouts.length,
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
    user.id,
    keyedWorkouts.map(({ key }) => key),
  );

  for (const workout of workouts) {
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

    let exported: Awaited<ReturnType<typeof exportSuuntoWorkout>>;
    try {
      exported = await exportSuuntoWorkout(sessionJson, key);
    } catch (error) {
      if (error instanceof SuuntoSidecarError && error.reason === "auth_expired") {
        await markSuuntoNeedsReconnect(user.id);
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
      const staged = await stageSuuntoImport(user.id, {
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

  await markSuuntoFetched(user.id);
  const [pendingCount, pending] = await Promise.all([
    countPendingSuuntoImports(user.id),
    listPendingSuuntoImports(user.id),
  ]);

  revalidateSuuntoPaths();
  return { ok: true, ...counts, pendingCount, nextImportId: pending[0]?.id ?? null };
}

export async function createSuuntoDiveImportAction(
  importId: number,
  input: DiveInput,
): Promise<SaveSuuntoImportActionResult> {
  const user = await requireUser();

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
}

export async function mergeSuuntoDiveImportAction(
  importId: number,
  targetDiveId: number,
  input: DiveInput,
): Promise<SaveSuuntoImportActionResult> {
  const user = await requireUser();

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
}

export async function deleteSuuntoImportAction(importId: number): Promise<DeleteSuuntoImportActionResult> {
  const user = await requireUser();
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
}
