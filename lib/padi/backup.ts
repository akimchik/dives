import "server-only";

import pg from "pg";

import type { DiveOwner } from "@/lib/dives";
import { getDatabaseUrl } from "@/lib/database-url";
import { getPadiCredentials, isPadiReconnectRequired } from "./auth";
import { mapWithConcurrency } from "./concurrency";
import { fetchLogbookDetail as defaultFetchLogbookDetail, fetchLogbookPage as defaultFetchLogbookPage } from "./client";
import { markPadiBackupDone } from "./integrations";

// PADI's own logbook UI pages at 15 -- matches lib/padi/sync.ts's PAGE_SIZE.
const PAGE_SIZE = 15;
const DETAIL_FETCH_CONCURRENCY = 5;
// A backup is only useful whole, unlike sync's dive-by-dive import: there's no "click again to
// continue" story for a file download, so this budget is generous (vs. sync's 45s) and a budget
// hit is reported as a real failure (reason: "too_large") rather than a partial result.
const WALL_TIME_BUDGET_MS = 120_000;
// Distinct from sync.ts's ADVISORY_LOCK_CLASSID (84271) so the two features' locks never collide.
// Unlike sync, this is read-only (no correctness reason to serialize), but a user firing multiple
// concurrent backups would each hold a full logbook in memory for up to WALL_TIME_BUDGET_MS while
// driving DETAIL_FETCH_CONCURRENCY PADI requests -- the lock caps that to one in flight per user.
const ADVISORY_LOCK_CLASSID = 84272;

interface PadiBackupClient {
  fetchLogbookPage: typeof defaultFetchLogbookPage;
  fetchLogbookDetail: typeof defaultFetchLogbookDetail;
}

const defaultPadiClient: PadiBackupClient = {
  fetchLogbookPage: defaultFetchLogbookPage,
  fetchLogbookDetail: defaultFetchLogbookDetail,
};

export type BackupPadiLogbookResult =
  | { ok: true; filename: string; data: string; count: number; skipped: number }
  | {
      ok: false;
      error: string;
      reason: "not_connected" | "reconnect_required" | "infrastructure" | "too_large" | "in_progress";
    };

/**
 * Walks the user's entire PADI logbook (same paging as lib/padi/sync.ts) and returns every raw
 * logbook detail record PADI has for them as one timestamped JSON file, for issue #14's "Backup
 * PADI dives" button. Read-only -- it never touches the local `dives` table.
 *
 * `padiClient` is injectable for tests, mirroring lib/padi/sync.ts's own `padiClient` param.
 */
export async function fetchPadiBackup(
  owner: DiveOwner,
  { padiClient = defaultPadiClient }: { padiClient?: PadiBackupClient } = {},
): Promise<BackupPadiLogbookResult> {
  const credentials = await getPadiCredentials(owner.id);
  if (!credentials.ok) return credentials;
  const { bearerToken, affiliateId } = credentials;

  // Dedicated, single-use client for the advisory lock -- see lib/padi/sync.ts's identical
  // pattern/comment on why this must not be a pooled connection.
  const lockClient = new pg.Client({ connectionString: getDatabaseUrl() });
  await lockClient.connect();

  let lockAcquired = false;
  try {
    const lockResult = await lockClient.query<{ pg_try_advisory_lock: boolean }>(
      "select pg_try_advisory_lock($1::int4, $2::int4)",
      [ADVISORY_LOCK_CLASSID, Number(owner.id)],
    );
    lockAcquired = lockResult.rows[0].pg_try_advisory_lock;

    if (!lockAcquired) {
      return { ok: false, error: "A PADI backup is already running.", reason: "in_progress" };
    }

    return await runBackup({ owner, bearerToken, affiliateId, padiClient });
  } finally {
    if (lockAcquired) {
      try {
        await lockClient.query("select pg_advisory_unlock($1::int4, $2::int4)", [
          ADVISORY_LOCK_CLASSID,
          Number(owner.id),
        ]);
      } catch {
        // Best-effort: the connection closes immediately below regardless, which releases the
        // session-scoped lock either way.
      }
    }
    await lockClient.end();
  }
}

async function runBackup({
  owner,
  bearerToken,
  affiliateId,
  padiClient,
}: {
  owner: DiveOwner;
  bearerToken: string;
  affiliateId: string;
  padiClient: PadiBackupClient;
}): Promise<BackupPadiLogbookResult> {
  const deadline = Date.now() + WALL_TIME_BUDGET_MS;
  const dives: unknown[] = [];
  let skipped = 0;
  let offset = 0;

  while (true) {
    let page;
    try {
      page = await padiClient.fetchLogbookPage(bearerToken, affiliateId, { limit: PAGE_SIZE, offset });
    } catch (error) {
      if (isPadiReconnectRequired(error)) {
        return { ok: false, error: "PADI needs to be reconnected", reason: "reconnect_required" };
      }
      console.error("PADI backup failed while listing the logbook", error);
      return { ok: false, error: "Backup failed while listing your PADI logbook", reason: "infrastructure" };
    }

    const summaries = page?.data?.logbook_logs ?? [];
    if (summaries.length === 0) break;

    const ids = (summaries as Array<{ id: number }>).map((summary) => summary.id);
    let reconnectRequired = false;

    const details = await mapWithConcurrency(ids, DETAIL_FETCH_CONCURRENCY, async (id) => {
      try {
        const detail = await padiClient.fetchLogbookDetail(bearerToken, affiliateId, id);
        return detail?.data?.logbook_logs?.[0] ?? null;
      } catch (error) {
        if (isPadiReconnectRequired(error)) {
          reconnectRequired = true;
        } else {
          console.error(`PADI backup failed to fetch logbook detail ${id}`, error);
        }
        return null;
      }
    });

    if (reconnectRequired) {
      return { ok: false, error: "PADI needs to be reconnected", reason: "reconnect_required" };
    }

    for (const detail of details) {
      if (detail) {
        dives.push(detail);
      } else {
        skipped += 1;
      }
    }

    if (summaries.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;

    if (Date.now() >= deadline) {
      return {
        ok: false,
        error: "Your PADI logbook is too large to back up in one request. Please try again.",
        reason: "too_large",
      };
    }
  }

  const exportedAt = new Date();
  const payload = {
    exportedAt: exportedAt.toISOString(),
    affiliateId,
    diveCount: dives.length,
    dives,
  };
  const filename = `padi-backup-${exportedAt.toISOString().replace(/[:.]/g, "-")}.json`;

  // A backup with any skipped dive is incomplete, and marking it done would permanently suppress
  // CreatePadiDiveButton's pre-upload nudge over a file that isn't actually a full backup -- so
  // backup_done_at is only ever set once every dive in the logbook was fetched successfully
  // (skipped === 0 also covers the legitimate "logbook is empty" case: 0 dives, 0 skipped).
  if (skipped === 0) {
    await markPadiBackupDone(owner.id);
  }

  return { ok: true, filename, data: JSON.stringify(payload), count: dives.length, skipped };
}
