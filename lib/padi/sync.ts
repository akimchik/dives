import "server-only";

import pg from "pg";

import { createDiveFromPadi, type DiveOwner } from "@/lib/dives";
import { getPool, queryRead } from "@/lib/db";
import { getDatabaseUrl } from "@/lib/database-url";
import { assertKeyConfigured, decryptSecret, keyFromEnvValue } from "./crypto";
import {
  PadiApiError,
  decodeIdTokenClaims,
  fetchLogbookDetail as defaultFetchLogbookDetail,
  fetchLogbookPage as defaultFetchLogbookPage,
} from "./client";
import { mapPadiLogToDive, type PadiLogbookDetail } from "./field-map";

// Non-blocking advisory lock (pg_try_advisory_lock's two-arg form) keyed by a fixed classid so this
// feature's locks never collide with any other advisory lock this app might use in the future.
// Arbitrary, just needs to stay fixed once chosen.
const ADVISORY_LOCK_CLASSID = 84271;

// PADI's own logbook UI pages at 15 -- matches the sample requests in `scratch`.
const PAGE_SIZE = 15;
// Detail fetches (HTTP) run with this much concurrency; inserts are applied one at a time (see the
// main loop below) so the sync's own DB-connection footprint stays small and predictable regardless
// of how parallel the HTTP side is.
const DETAIL_FETCH_CONCURRENCY = 5;
// Wall-time budget. The actual ingress read-timeout is unconfirmed operationally, so this stays
// well under any plausible default -- a budget hit is always safe: createDiveFromPadi's
// on-conflict-do-nothing insert makes a follow-up sync (or the user clicking Sync again) idempotent
// and cheap, so returning early here is a resumoption, not a failure.
const WALL_TIME_BUDGET_MS = 45_000;

export type SyncPadiResult =
  | { ok: true; imported: number; skipped: number; remaining: boolean }
  | { ok: false; error: string; reason: "not_connected" | "reconnect_required" | "in_progress" | "infrastructure" };

interface PadiIntegrationRow {
  access_token_encrypted: string;
  id_token_encrypted: string;
  status: string;
}

interface PadiLogbookClient {
  fetchLogbookPage: typeof defaultFetchLogbookPage;
  fetchLogbookDetail: typeof defaultFetchLogbookDetail;
}

const defaultPadiClient: PadiLogbookClient = {
  fetchLogbookPage: defaultFetchLogbookPage,
  fetchLogbookDetail: defaultFetchLogbookDetail,
};

async function getIntegration(userId: string): Promise<PadiIntegrationRow | null> {
  const result = await queryRead<PadiIntegrationRow>(
    "select access_token_encrypted, id_token_encrypted, status from padi_integrations where user_id = $1",
    [userId],
  );
  return result.rows[0] ?? null;
}

// Optimization only, not a correctness mechanism -- createDiveFromPadi's on-conflict-do-nothing
// insert is the actual dedup authority. This just avoids a detail-fetch round trip per dive PADI has
// already given us in a previous sync.
async function alreadyImportedIds(userId: string, padiDiveIds: number[]): Promise<Set<number>> {
  if (padiDiveIds.length === 0) return new Set();

  const result = await queryRead<{ padi_dive_id: number }>(
    "select padi_dive_id from dives where user_id = $1 and padi_dive_id = any($2::int[])",
    [userId, padiDiveIds],
  );
  return new Set(result.rows.map((row) => row.padi_dive_id));
}

// Small fixed-concurrency map -- no existing concurrency-limiter utility elsewhere in this repo, and
// pulling in a dependency for this one call site isn't warranted.
async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await fn(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function isReconnectRequired(error: unknown): boolean {
  return error instanceof PadiApiError && error.status === 401;
}

/**
 * Imports the user's entire PADI logbook, insert-only, deduped by `padi_dive_id`. Never refreshes
 * PADI tokens itself -- that's the token-refresh CronJob's exclusive responsibility (see
 * scripts/padi-token-refresh.mjs); a 401 here means the caller needs to wait for the next refresh
 * cycle or reconnect, not that this function should retry with a refresh of its own.
 *
 * `padiClient` is injectable for tests, mirroring scripts/notifications/queue.mjs's `sendMail`
 * injection in `processNotificationQueue`.
 */
export async function syncPadiLogbook(
  owner: DiveOwner,
  { padiClient = defaultPadiClient }: { padiClient?: PadiLogbookClient } = {},
): Promise<SyncPadiResult> {
  const integration = await getIntegration(owner.id);

  if (!integration) {
    return { ok: false, error: "PADI is not connected", reason: "not_connected" };
  }
  if (integration.status !== "connected") {
    return { ok: false, error: "PADI needs to be reconnected", reason: "reconnect_required" };
  }

  let accessToken: string;
  let affiliateId: string;
  try {
    assertKeyConfigured(process.env.PADI_TOKEN_ENCRYPTION_KEY);
    const key = keyFromEnvValue(process.env.PADI_TOKEN_ENCRYPTION_KEY);
    const previousKey = process.env.PADI_TOKEN_ENCRYPTION_KEY_PREVIOUS
      ? keyFromEnvValue(process.env.PADI_TOKEN_ENCRYPTION_KEY_PREVIOUS)
      : undefined;

    accessToken = decryptSecret(integration.access_token_encrypted, key, `${owner.id}:access`, previousKey);
    const idToken = decryptSecret(integration.id_token_encrypted, key, `${owner.id}:id`, previousKey);
    const claims = decodeIdTokenClaims(idToken);
    if (!claims.affiliateId) throw new Error("PADI idToken is missing custom:affiliate_id");
    affiliateId = String(claims.affiliateId);
  } catch (error) {
    // A misconfigured/rotated-out encryption key is an infrastructure problem, never a PADI-side
    // rejection -- must never be conflated with "needs_reconnect" (see the cronjob's identical
    // classification rule in scripts/padi/token-refresh.mjs).
    console.error("PADI sync failed to decrypt stored tokens", error);
    return { ok: false, error: "Sync temporarily unavailable", reason: "infrastructure" };
  }

  // Dedicated, single-use client for the advisory lock -- deliberately not a pooled connection.
  // pg_try_advisory_lock is session-scoped: it lives and dies with this one connection, so closing
  // this client (below, unconditionally) always releases the lock even if the explicit unlock query
  // itself fails -- unlike a pooled connection, there is no "return to the pool for reuse" step that
  // could leak a still-held lock into someone else's borrowed client.
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
      return { ok: false, error: "Sync already in progress", reason: "in_progress" };
    }

    const result = await runSync({ owner, accessToken, affiliateId, padiClient });
    if (result.ok) {
      await getPool().query("update padi_integrations set synced_at = now() where user_id = $1", [owner.id]);
    }
    return result;
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

async function runSync({
  owner,
  accessToken,
  affiliateId,
  padiClient,
}: {
  owner: DiveOwner;
  accessToken: string;
  affiliateId: string;
  padiClient: PadiLogbookClient;
}): Promise<SyncPadiResult> {
  const deadline = Date.now() + WALL_TIME_BUDGET_MS;
  let imported = 0;
  let skipped = 0;
  let offset = 0;

  while (Date.now() < deadline) {
    let page;
    try {
      page = await padiClient.fetchLogbookPage(accessToken, affiliateId, { limit: PAGE_SIZE, offset });
    } catch (error) {
      if (isReconnectRequired(error)) {
        return { ok: false, error: "PADI needs to be reconnected", reason: "reconnect_required" };
      }
      console.error("PADI sync failed while listing the logbook", error);
      return { ok: false, error: "Sync failed while listing your PADI logbook", reason: "infrastructure" };
    }

    const summaries = page?.data?.logbook_logs ?? [];
    if (summaries.length === 0) break;

    const candidateIds: number[] = (summaries as Array<{ id: number }>).map((summary) => summary.id);
    const alreadyImported = await alreadyImportedIds(owner.id, candidateIds);
    const toFetch = candidateIds.filter((id) => !alreadyImported.has(id));
    skipped += candidateIds.length - toFetch.length;

    let reconnectRequired = false;

    const details = await mapWithConcurrency(toFetch, DETAIL_FETCH_CONCURRENCY, async (id) => {
      try {
        const detail = await padiClient.fetchLogbookDetail(accessToken, affiliateId, id);
        return { ok: true as const, record: detail?.data?.logbook_logs?.[0] };
      } catch (error) {
        if (isReconnectRequired(error)) {
          reconnectRequired = true;
        } else {
          console.error(`PADI sync failed to fetch logbook detail ${id}`, error);
        }
        return { ok: false as const };
      }
    });

    if (reconnectRequired) {
      return { ok: false, error: "PADI needs to be reconnected", reason: "reconnect_required" };
    }

    // Inserts are applied one at a time (concurrency 1), independent of the fetch concurrency above,
    // to keep this sync's own DB-connection footprint small and predictable.
    for (const detail of details) {
      if (!detail.ok || !detail.record) {
        skipped += 1;
        continue;
      }

      const record = detail.record as PadiLogbookDetail;
      const mapped = mapPadiLogToDive(record);
      if (!mapped.ok) {
        skipped += 1;
        continue;
      }

      try {
        const result = await createDiveFromPadi(owner, mapped.diveInput, mapped.padiFields);
        if (result.inserted) {
          imported += 1;
        } else {
          skipped += 1;
        }
      } catch (error) {
        console.error(`PADI sync failed to insert dive from logbook detail ${record.id}`, error);
        skipped += 1;
      }

      if (Date.now() >= deadline) {
        return { ok: true, imported, skipped, remaining: true };
      }
    }

    if (summaries.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;

    if (Date.now() >= deadline) {
      return { ok: true, imported, skipped, remaining: true };
    }
  }

  return { ok: true, imported, skipped, remaining: false };
}
