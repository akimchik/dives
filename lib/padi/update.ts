import "server-only";

import { getPool } from "@/lib/db";
import type { DiveOwner, DiveRecord } from "@/lib/dives";
import { DiveNotFoundError } from "@/lib/dives";
import { getPadiCredentials } from "./auth";
import { PadiApiError, updateRecreationalLogbookDive as defaultUpdateRecreationalLogbookDive } from "./client";
import { mapDiveToPadiUpdatePayload, padiCreateValidationError } from "./create";

export type UpdatePadiDiveResult =
  | { ok: true; padiDiveId: number }
  | {
      ok: false;
      error: string;
      reason:
        | "not_connected"
        | "not_linked"
        | "not_recreational"
        | "reconnect_required"
        | "validation"
        | "infrastructure";
    };

type PadiUpdateClient = {
  updateRecreationalLogbookDive: typeof defaultUpdateRecreationalLogbookDive;
};

const defaultClient: PadiUpdateClient = { updateRecreationalLogbookDive: defaultUpdateRecreationalLogbookDive };

function isRecreationalDive(dive: Pick<DiveRecord, "log_type" | "log_course">): boolean {
  return dive.log_type === "Recreational" && dive.log_course === null;
}

function allAffectedRows(response: unknown): number[] {
  if (!response || typeof response !== "object") return [];
  const data = (response as { data?: unknown }).data;
  if (!data || typeof data !== "object") return [];

  return [
    "update_logbook_logs",
    "update_logbook_depth_time",
    "update_logbook_conditions",
    "update_logbook_equipment",
    "update_logbook_experience",
  ].map((key) => {
    const entry = (data as Record<string, unknown>)[key];
    if (!entry || typeof entry !== "object") return 0;
    const affected = (entry as { affected_rows?: unknown }).affected_rows;
    return typeof affected === "number" ? affected : 0;
  });
}

async function clearPadiNeedsUpdate(owner: DiveOwner, diveId: number) {
  const result = await getPool().query(
    `
      update dives
      set padi_needs_update = false,
          padi_last_compared_at = now()
      where id = $1 and user_id = $2
    `,
    [diveId, owner.id],
  );

  if (result.rowCount === 0) throw new DiveNotFoundError();
}

export async function updateDiveInPadi(
  owner: DiveOwner,
  dive: DiveRecord,
  { padiClient = defaultClient }: { padiClient?: PadiUpdateClient } = {},
): Promise<UpdatePadiDiveResult> {
  if (dive.padi_dive_id === null) {
    return { ok: false, error: "This dive is not linked to PADI.", reason: "not_linked" };
  }

  if (!isRecreationalDive(dive)) {
    return {
      ok: false,
      error: "Only recreational PADI dives can be updated from this app.",
      reason: "not_recreational",
    };
  }

  const credentials = await getPadiCredentials(owner.id);
  if (!credentials.ok) return credentials;
  const { bearerToken, affiliateId } = credentials;

  const payload = mapDiveToPadiUpdatePayload(dive, affiliateId);
  if (!payload) return { ok: false, error: "This dive is not linked to PADI.", reason: "not_linked" };

  let response;
  try {
    response = await padiClient.updateRecreationalLogbookDive(bearerToken, affiliateId, payload);
  } catch (error) {
    if (error instanceof PadiApiError && error.status === 401) {
      return { ok: false, error: "PADI needs to be reconnected", reason: "reconnect_required" };
    }
    console.error("PADI update failed", error);
    return { ok: false, error: "Could not update this dive in PADI", reason: "infrastructure" };
  }

  const affectedRows = allAffectedRows(response);
  if (affectedRows.length !== 5 || affectedRows.some((count) => count !== 1)) {
    const validationError = padiCreateValidationError(response);
    console.error("PADI update returned unexpected affected rows", response);
    return {
      ok: false,
      error: validationError ?? "PADI did not confirm updating every recreational dive section",
      reason: validationError ? "validation" : "infrastructure",
    };
  }

  try {
    await clearPadiNeedsUpdate(owner, dive.id);
  } catch (error) {
    console.error("PADI update succeeded but local dive could not be marked current", error);
    return { ok: false, error: "PADI updated the dive, but local status could not be updated", reason: "infrastructure" };
  }

  return { ok: true, padiDiveId: dive.padi_dive_id };
}
