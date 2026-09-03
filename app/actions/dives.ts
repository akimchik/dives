"use server";

import { revalidatePath } from "next/cache";

import {
  createDive,
  deleteDive,
  findOrCreateDiveSite,
  listDiveSites,
  updateDive,
  DiveNotFoundError,
  DiveSiteNotFoundError,
  type DiveInput,
  type DiveSiteRow,
} from "@/lib/dives";
import { requireUser } from "@/lib/session";

// Buttons calling these show a spinner and toast the outcome (AGENTS.md), so failures come back as
// a result rather than a thrown error: a dive id owned by somebody else is reported as plain
// "not found", never as that user's data.
export type DiveActionResult = { ok: true; id: number } | { ok: false; error: string };

function toActionError(error: unknown): { ok: false; error: string } {
  if (error instanceof DiveNotFoundError) {
    return { ok: false, error: "Dive not found." };
  }

  if (error instanceof DiveSiteNotFoundError) {
    return { ok: false, error: "Dive site not found." };
  }

  console.error("Dive action failed", error);
  return { ok: false, error: "Something went wrong. Please try again." };
}

function revalidateDives(diveId?: number) {
  revalidatePath("/dives");
  revalidatePath("/dashboard");
  if (diveId !== undefined) revalidatePath(`/dives/${diveId}`);
}

// Autocomplete source for the dive form's site field -- the session user's own sites only.
export async function searchDiveSitesAction(query?: string): Promise<DiveSiteRow[]> {
  const user = await requireUser();
  return listDiveSites(user.id, query);
}

// Create-or-reuse for a name typed into that autocomplete.
export async function createDiveSiteAction(input: {
  name: string;
  location?: string | null;
  lat?: number | null;
  lng?: number | null;
}): Promise<{ ok: true; site: DiveSiteRow } | { ok: false; error: string }> {
  const user = await requireUser();

  try {
    return { ok: true, site: await findOrCreateDiveSite(user.id, input) };
  } catch (error) {
    return toActionError(error);
  }
}

export async function createDiveAction(input: DiveInput): Promise<DiveActionResult> {
  const user = await requireUser();

  try {
    const dive = await createDive(user, input);
    revalidateDives(dive.id);
    return { ok: true, id: dive.id };
  } catch (error) {
    return toActionError(error);
  }
}

export async function updateDiveAction(diveId: number, input: DiveInput): Promise<DiveActionResult> {
  const user = await requireUser();

  try {
    const dive = await updateDive(user, diveId, input);
    revalidateDives(dive.id);
    return { ok: true, id: dive.id };
  } catch (error) {
    return toActionError(error);
  }
}

export async function deleteDiveAction(diveId: number): Promise<DiveActionResult> {
  const user = await requireUser();

  try {
    const dive = await deleteDive(user, diveId);
    revalidateDives(diveId);
    return { ok: true, id: dive.id };
  } catch (error) {
    return toActionError(error);
  }
}
