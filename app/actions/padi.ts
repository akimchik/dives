"use server";

import { revalidatePath } from "next/cache";

import { requireUser } from "@/lib/session";
import { getDive } from "@/lib/dives";
import { assertKeyConfigured } from "@/lib/padi/crypto";
import { login, PadiApiError } from "@/lib/padi/client";
import { deletePadiIntegration, dismissPadiBackupPrompt, savePadiIntegration } from "@/lib/padi/integrations";
import { checkRateLimit, hashUsername, isRateLimited, recordFailedAttempt } from "@/lib/padi/rate-limit";
import { fetchPadiBackup, type BackupPadiLogbookResult } from "@/lib/padi/backup";
import { createDiveInPadi, type CreatePadiDiveResult } from "@/lib/padi/create";
import { syncPadiLogbook, type SyncPadiResult } from "@/lib/padi/sync";
import { updateDiveInPadi, type UpdatePadiDiveResult } from "@/lib/padi/update";

const UNAVAILABLE_ERROR = "PADI sync is temporarily unavailable. Please try again later.";

// Buttons calling these show a spinner and toast the outcome (AGENTS.md rule 5), so failures come
// back as a result rather than a thrown error -- same discriminated-union convention as
// app/actions/dives.ts's DiveActionResult.
export type PadiActionResult = { ok: true } | { ok: false; error: string };

type CreatePadiDiveFailureReason = Extract<CreatePadiDiveResult, { ok: false }>["reason"];
type UpdatePadiDiveFailureReason = Extract<UpdatePadiDiveResult, { ok: false }>["reason"];

export type CreatePadiDiveActionResult =
  | { ok: true; padiDiveId: number }
  | { ok: false; error: string; reason: CreatePadiDiveFailureReason | "not_found" };

export type UpdatePadiDiveActionResult =
  | { ok: true; padiDiveId: number }
  | { ok: false; error: string; reason: UpdatePadiDiveFailureReason | "not_found" };

function revalidatePadiPaths() {
  revalidatePath("/dashboard");
  revalidatePath("/settings/integrations");
}

// Never logs the raw password or a raw token -- PadiApiError's message is already sanitized
// (scripts/padi/client.mjs never lets the request body, which contains the password on login,
// reach a thrown error), and this action never constructs its own error message from the raw
// credentials either.
export async function connectPadiAction(username: string, password: string): Promise<PadiActionResult> {
  const user = await requireUser();

  let usernameHash: string;
  try {
    usernameHash = hashUsername(username);
  } catch {
    // PADI_USERNAME_HASH_PEPPER unset/placeholder -- an infrastructure problem, not something the
    // user can fix by retrying, so it must not be recorded as a failed attempt either.
    return { ok: false, error: UNAVAILABLE_ERROR };
  }

  const rateLimitCheck = await checkRateLimit(user.id, usernameHash);
  if (isRateLimited(rateLimitCheck)) {
    return { ok: false, error: "Too many attempts. Please wait a while before trying again." };
  }

  // The PADI call and the local save are two separate try/catches on purpose: a
  // padi_login_attempts row must only ever record that PADI itself rejected these credentials
  // (per this story's acceptance criteria), never a local failure (e.g. a misconfigured encryption
  // key) that happens after PADI already accepted them -- otherwise a run of local failures spends
  // the user's own rate-limit budget for a problem that isn't theirs and isn't fixed by retrying
  // with different credentials.
  let tokens: Awaited<ReturnType<typeof login>>["tokens"];
  try {
    ({ tokens } = await login(username, password));
  } catch (error) {
    await recordFailedAttempt(user.id, usernameHash);

    if (error instanceof PadiApiError) {
      return { ok: false, error: "Could not sign in to PADI. Check your login and password." };
    }
    return { ok: false, error: "Something went wrong. Please try again." };
  }

  try {
    assertKeyConfigured(process.env.PADI_TOKEN_ENCRYPTION_KEY);
    await savePadiIntegration(user.id, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      idToken: tokens.idToken,
      expiresIn: tokens.expiresIn,
      usernameHash,
    });
  } catch {
    return { ok: false, error: UNAVAILABLE_ERROR };
  }

  revalidatePadiPaths();
  return { ok: true };
}

export async function disconnectPadiAction(): Promise<PadiActionResult> {
  const user = await requireUser();
  await deletePadiIntegration(user.id);
  revalidatePadiPaths();
  return { ok: true };
}

export async function syncPadiAction(): Promise<SyncPadiResult> {
  const user = await requireUser();
  const result = await syncPadiLogbook(user);

  if (result.ok) {
    revalidatePath("/dashboard");
    revalidatePath("/dives");
  }

  return result;
}

export async function backupPadiAction(): Promise<BackupPadiLogbookResult> {
  const user = await requireUser();
  const result = await fetchPadiBackup(user);

  if (result.ok) {
    revalidatePadiPaths();
  }

  return result;
}

// Called when the user explicitly skips the "back up before your first upload" nudge (issue #14)
// on CreatePadiDiveButton -- always chained straight into createPadiDiveAction from there, so this
// itself doesn't need to revalidate anything beyond what that follow-up call already does.
export async function dismissPadiBackupPromptAction(): Promise<PadiActionResult> {
  const user = await requireUser();
  await dismissPadiBackupPrompt(user.id);
  return { ok: true };
}

export async function createPadiDiveAction(diveId: number): Promise<CreatePadiDiveActionResult> {
  const user = await requireUser();
  const dive = await getDive(user.id, diveId);

  if (!dive) return { ok: false, error: "Dive not found", reason: "not_found" };

  const result = await createDiveInPadi(user, dive);
  if (!result.ok) return result;

  revalidatePath("/dashboard");
  revalidatePath("/dives");
  revalidatePath(`/dives/${diveId}`);

  return result;
}

export async function updatePadiDiveAction(diveId: number): Promise<UpdatePadiDiveActionResult> {
  const user = await requireUser();
  const dive = await getDive(user.id, diveId);

  if (!dive) return { ok: false, error: "Dive not found", reason: "not_found" };

  const result = await updateDiveInPadi(user, dive);
  if (!result.ok) return result;

  revalidatePath("/dashboard");
  revalidatePath("/dives");
  revalidatePath(`/dives/${diveId}`);

  return result;
}
