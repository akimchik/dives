import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Integration test against a real Postgres, mirroring tests/integration/padi-sync.test.ts's
// convention (fake padiClient injected into the real credential-resolution/DB-write path).
// Covers issue #14: fetchPadiBackup's pagination over the full logbook, its reconnect/not-connected/
// infrastructure/too_large/in_progress classification (the first three shared with sync via
// lib/padi/auth.ts), and that a successful, complete (skipped === 0) backup records backup_done_at
// -- while an incomplete one deliberately does not (see the HIGH-severity fix in backup.ts's git
// history: marking an incomplete backup done would permanently suppress the pre-upload nudge over a
// file that isn't actually a full backup).
import { closeTestPool, getTestPool } from "./helpers/pg";

const TEST_KEY_BASE64 = Buffer.from("2".repeat(32)).toString("base64");
process.env.PADI_TOKEN_ENCRYPTION_KEY = TEST_KEY_BASE64;

const { encryptSecret } = await import("@/lib/padi/crypto");
const { fetchPadiBackup } = await import("@/lib/padi/backup");
const { PadiApiError } = await import("@/lib/padi/client");

type Owner = { id: string; email: string };

function fakeIdToken(affiliateId: string) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ "custom:affiliate_id": affiliateId })).toString("base64url");
  return `${header}.${payload}.signature`;
}

async function createConnectedOwner(): Promise<Owner> {
  const email = `padi-backup-${randomUUID()}@example.com`;
  const userResult = await getTestPool().query<{ id: number }>(
    "insert into users (email, password_hash) values ($1, 'x') returning id",
    [email],
  );
  const id = String(userResult.rows[0].id);

  await getTestPool().query(
    `
      insert into padi_integrations
        (user_id, username_hash, access_token_encrypted, refresh_token_encrypted, id_token_encrypted, expires_at, status)
      values ($1, $2, $3, $4, $5, now() + interval '1 hour', 'connected')
    `,
    [
      id,
      `hash-${id}`,
      encryptSecret("access-token", Buffer.from(TEST_KEY_BASE64, "base64"), `${id}:access`),
      encryptSecret("refresh-token", Buffer.from(TEST_KEY_BASE64, "base64"), `${id}:refresh`),
      encryptSecret(fakeIdToken("87654321"), Buffer.from(TEST_KEY_BASE64, "base64"), `${id}:id`),
    ],
  );

  return { id, email };
}

// A small fake logbook -- `pages` is a list of id-arrays, one per fetchLogbookPage call
// (deliberately not size-15 dependent, since backup.ts's own PAGE_SIZE constant decides when it
// stops paging, exactly like sync's).
function makeFakeClient(pages: number[][], failingDetailIds: Set<number> = new Set()) {
  let pageCalls = 0;
  let detailCalls = 0;

  return {
    client: {
      async fetchLogbookPage(_bearer: string, _affiliateId: string | number, { offset }: { limit?: number; offset?: number }) {
        pageCalls += 1;
        const pageIndex = Math.floor((offset ?? 0) / 15);
        const ids = pages[pageIndex] ?? [];
        return { data: { logbook_logs: ids.map((id) => ({ id, dive_title: `Dive ${id}` })) } };
      },
      async fetchLogbookDetail(_bearer: string, _affiliateId: string | number, id: string | number) {
        detailCalls += 1;
        if (failingDetailIds.has(Number(id))) throw new Error("boom");
        return { data: { logbook_logs: [{ id: Number(id), dive_title: `Dive ${id}`, notes: "full detail" }] } };
      },
    },
    calls: () => ({ pageCalls, detailCalls }),
  };
}

async function backupDoneAt(userId: string) {
  const result = await getTestPool().query<{ backup_done_at: Date | null }>(
    "select backup_done_at from padi_integrations where user_id = $1",
    [userId],
  );
  return result.rows[0]?.backup_done_at ?? null;
}

async function purgeOwnUsers() {
  await getTestPool().query("delete from users where email like 'padi-backup-%@example.com'");
}

beforeAll(async () => {
  process.env.PADI_TOKEN_ENCRYPTION_KEY = TEST_KEY_BASE64;
  await purgeOwnUsers();
});

afterAll(async () => {
  await purgeOwnUsers();
  await closeTestPool();
});

describe("fetchPadiBackup", () => {
  it("collects every dive across a single page into one timestamped JSON file", async () => {
    const owner = await createConnectedOwner();
    const { client } = makeFakeClient([[701001, 701002, 701003]]);

    const result = await fetchPadiBackup(owner, { padiClient: client });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.count).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.filename).toMatch(/^padi-backup-.*\.json$/);

    const payload = JSON.parse(result.data);
    expect(payload.diveCount).toBe(3);
    expect(payload.dives.map((dive: { id: number }) => dive.id).sort()).toEqual([701001, 701002, 701003]);

    expect(await backupDoneAt(owner.id)).not.toBeNull();
  });

  it("walks multiple pages until a short page ends the logbook", async () => {
    const owner = await createConnectedOwner();
    const fullPage = Array.from({ length: 15 }, (_, index) => 702000 + index);
    const { client, calls } = makeFakeClient([fullPage, [702100, 702101]]);

    const result = await fetchPadiBackup(owner, { padiClient: client });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.count).toBe(17);
    expect(calls().pageCalls).toBe(2);
  });

  it("counts a dive whose detail fetch fails as skipped rather than failing the whole backup, but does NOT mark the backup done", async () => {
    const owner = await createConnectedOwner();
    const { client } = makeFakeClient([[703001, 703002]], new Set([703002]));

    const result = await fetchPadiBackup(owner, { padiClient: client });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.count).toBe(1);
    expect(result.skipped).toBe(1);
    // Regression: an incomplete backup must never suppress CreatePadiDiveButton's pre-upload
    // nudge -- backup_done_at only gets set once every dive was actually fetched.
    expect(await backupDoneAt(owner.id)).toBeNull();
  });

  it("never touches the local dives table", async () => {
    const owner = await createConnectedOwner();
    const { client } = makeFakeClient([[704001, 704002]]);

    await fetchPadiBackup(owner, { padiClient: client });

    const diveRows = await getTestPool().query("select count(*)::int as count from dives where user_id = $1", [
      owner.id,
    ]);
    expect(diveRows.rows[0].count).toBe(0);
  });

  it("returns not_connected when the user has no padi_integrations row", async () => {
    const email = `padi-backup-none-${randomUUID()}@example.com`;
    const userResult = await getTestPool().query<{ id: number }>(
      "insert into users (email, password_hash) values ($1, 'x') returning id",
      [email],
    );
    const owner = { id: String(userResult.rows[0].id), email };

    const result = await fetchPadiBackup(owner, { padiClient: makeFakeClient([]).client });
    expect(result).toEqual({ ok: false, error: "PADI is not connected", reason: "not_connected" });
  });

  it("returns reconnect_required when the integration status is needs_reconnect", async () => {
    const owner = await createConnectedOwner();
    await getTestPool().query("update padi_integrations set status = 'needs_reconnect' where user_id = $1", [
      owner.id,
    ]);

    const result = await fetchPadiBackup(owner, { padiClient: makeFakeClient([]).client });
    expect(result).toEqual({ ok: false, error: "PADI needs to be reconnected", reason: "reconnect_required" });
    expect(await backupDoneAt(owner.id)).toBeNull();
  });

  it("returns reconnect_required when PADI rejects the page listing with a 401", async () => {
    const owner = await createConnectedOwner();
    const client = {
      async fetchLogbookPage() {
        throw new PadiApiError("PADI request failed with status 401", 401);
      },
      async fetchLogbookDetail() {
        throw new Error("unreachable");
      },
    };

    const result = await fetchPadiBackup(owner, { padiClient: client });
    expect(result).toEqual({ ok: false, error: "PADI needs to be reconnected", reason: "reconnect_required" });
  });

  it("returns reconnect_required when PADI rejects a detail fetch with a 401", async () => {
    const owner = await createConnectedOwner();
    const client = {
      async fetchLogbookPage() {
        return { data: { logbook_logs: [{ id: 705001 }] } };
      },
      async fetchLogbookDetail() {
        throw new PadiApiError("PADI request failed with status 401", 401);
      },
    };

    const result = await fetchPadiBackup(owner, { padiClient: client });
    expect(result).toEqual({ ok: false, error: "PADI needs to be reconnected", reason: "reconnect_required" });
  });

  it("returns infrastructure when listing the logbook fails for a non-401 reason", async () => {
    const owner = await createConnectedOwner();
    const client = {
      async fetchLogbookPage() {
        throw new Error("PADI is down");
      },
      async fetchLogbookDetail() {
        throw new Error("unreachable");
      },
    };

    const result = await fetchPadiBackup(owner, { padiClient: client });
    expect(result).toEqual({
      ok: false,
      error: "Backup failed while listing your PADI logbook",
      reason: "infrastructure",
    });
  });

  it("returns too_large instead of a partial file once the wall-time budget elapses", async () => {
    vi.useFakeTimers();
    try {
      const owner = await createConnectedOwner();
      const fullPage = Array.from({ length: 15 }, (_, index) => 706000 + index);
      let pageCalls = 0;
      const client = {
        async fetchLogbookPage() {
          pageCalls += 1;
          // First page: a full page (keeps the loop going). Advance the fake clock past the
          // 120s budget before the loop's own deadline check runs, so the *second* page fetch
          // never happens -- this proves the budget is honored rather than merely documented.
          if (pageCalls === 1) {
            vi.advanceTimersByTime(130_000);
            return { data: { logbook_logs: fullPage.map((id) => ({ id })) } };
          }
          throw new Error("must not fetch a second page once the budget has elapsed");
        },
        async fetchLogbookDetail(_bearer: string, _affiliateId: string | number, id: string | number) {
          return { data: { logbook_logs: [{ id: Number(id) }] } };
        },
      };

      const result = await fetchPadiBackup(owner, { padiClient: client });
      expect(result).toEqual({
        ok: false,
        error: "Your PADI logbook is too large to back up in one request. Please try again.",
        reason: "too_large",
      });
      expect(pageCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns in_progress for a concurrent backup instead of duplicating PADI reads", async () => {
    const owner = await createConnectedOwner();
    let releaseFirstCall: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirstCall = resolve;
    });

    const slowClient = {
      async fetchLogbookPage() {
        await gate;
        return { data: { logbook_logs: [] } };
      },
      async fetchLogbookDetail() {
        return { data: { logbook_logs: [] } };
      },
    };

    const firstCall = fetchPadiBackup(owner, { padiClient: slowClient });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = await fetchPadiBackup(owner, { padiClient: slowClient });
    expect(second).toEqual({ ok: false, error: "A PADI backup is already running.", reason: "in_progress" });

    releaseFirstCall();
    const first = await firstCall;
    expect(first.ok).toBe(true);
  });
});
