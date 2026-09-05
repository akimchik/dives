"use server";

import { revalidatePath } from "next/cache";

import {
  DiveSiteNotFoundError,
  mergeDiveSites,
  updateDiveSite,
  type DiveSiteInput,
  type DiveSiteMergeInput,
  type DiveSiteMergeResult,
  type DiveSiteWithDiveCount,
} from "@/lib/dives";
import { requireUser } from "@/lib/session";

export type DiveSiteActionResult =
  | { ok: true; site: DiveSiteWithDiveCount }
  | { ok: false; error: string };

export type DiveSiteMergeActionResult =
  | ({ ok: true } & DiveSiteMergeResult)
  | { ok: false; error: string };

function revalidateDiveSitePaths() {
  revalidatePath("/dive-sites");
  revalidatePath("/dives");
  revalidatePath("/dashboard");
}

function toDiveSiteActionError(error: unknown): { ok: false; error: string } {
  if (error instanceof DiveSiteNotFoundError) {
    return { ok: false, error: "Dive site not found." };
  }

  if (error instanceof Error && /required|different/i.test(error.message)) {
    return { ok: false, error: error.message };
  }

  console.error("Dive site action failed", error);
  return { ok: false, error: "Something went wrong. Please try again." };
}

export async function updateDiveSiteAction(siteId: number, input: DiveSiteInput): Promise<DiveSiteActionResult> {
  const user = await requireUser();

  try {
    const site = await updateDiveSite(user.id, siteId, input);
    revalidateDiveSitePaths();
    return { ok: true, site };
  } catch (error) {
    return toDiveSiteActionError(error);
  }
}

export async function mergeDiveSitesAction(input: DiveSiteMergeInput): Promise<DiveSiteMergeActionResult> {
  const user = await requireUser();

  try {
    const result = await mergeDiveSites(user.id, input);
    revalidateDiveSitePaths();
    return { ok: true, ...result };
  } catch (error) {
    return toDiveSiteActionError(error);
  }
}
