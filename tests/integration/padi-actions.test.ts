import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Integration test for app/actions/padi.ts, run against a real Postgres. Follows
// tests/integration/registration.test.ts's convention for testing a server action: next/headers
// (cookies) / next/navigation (redirect) / next/cache (revalidatePath) are mocked so real
// framework-independent DB/session logic runs for real, while @/lib/padi/client's `login` is
// mocked so no real HTTP call to PADI happens and its call count is directly assertable --
// this is what makes the rate-limit-blocks-before-calling-PADI acceptance criterion testable.
import { closeTestPool, getTestPool } from "./helpers/pg";

type CookieStore = Map<string, { value: string }>;
const cookieStore: CookieStore = new Map();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => cookieStore.get(name),
    set: (name: string, value: string) => {
      cookieStore.set(name, { value });
    },
    delete: (name: string) => {
      cookieStore.delete(name);
    },
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error(`REDIRECT:${url}`);
    (error as Error & { digest: string }).digest = `NEXT_REDIRECT;${url}`;
    throw error;
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const loginMock = vi.fn();
// backupPadiAction's real dependency (lib/padi/backup.ts) calls fetchLogbookPage/fetchLogbookDetail
// through this same module, so both are mocked here too -- otherwise the backupPadiAction tests
// below would make real HTTP calls to PADI. Default to an empty logbook so every other test in this
// file (which never touches backup) is unaffected.
const fetchLogbookPageMock = vi.fn().mockResolvedValue({ data: { logbook_logs: [] } });
const fetchLogbookDetailMock = vi.fn();
vi.mock("@/lib/padi/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/padi/client")>();
  return {
    ...actual,
    login: (...args: unknown[]) => loginMock(...args),
    fetchLogbookPage: (...args: unknown[]) => fetchLogbookPageMock(...args),
    fetchLogbookDetail: (...args: unknown[]) => fetchLogbookDetailMock(...args),
  };
});

// Lets a test simulate a successful PADI login followed by a LOCAL failure (e.g. a misconfigured
// encryption key) -- the regression test below for "a local failure must not spend the rate-limit
// budget" needs to fail *after* login succeeds, which mocking `login` alone can't produce. Defaults
// to the real implementation (set in beforeEach below) so every other test's connect actually
// persists a row as normal; only the one test that needs the failure overrides it for that call.
const saveIntegrationMock = vi.fn();
vi.mock("@/lib/padi/integrations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/padi/integrations")>();
  return { ...actual, savePadiIntegration: (...args: unknown[]) => saveIntegrationMock(...args) };
});

const TEST_KEY_BASE64 = Buffer.from("1".repeat(32)).toString("base64");
process.env.PADI_TOKEN_ENCRYPTION_KEY = TEST_KEY_BASE64;
process.env.PADI_USERNAME_HASH_PEPPER = "test-pepper";

const { createSession } = await import("@/lib/session");
const { createUser } = await import("@/lib/users");
const { backupPadiAction, connectPadiAction, disconnectPadiAction, dismissPadiBackupPromptAction, syncPadiAction } =
  await import("@/app/actions/padi");
const { PadiApiError } = await import("@/lib/padi/client");
// vi.importActual, not a plain import -- "@/lib/padi/integrations" is mocked above, so importing
// it normally here would just return the mock wrapper again (calling it would recurse into
// itself). importActual bypasses the mock to get the true original implementation.
const { savePadiIntegration: realSavePadiIntegration } =
  await vi.importActual<typeof import("@/lib/padi/integrations")>("@/lib/padi/integrations");

function fakeTokens() {
  return { tokens: { accessToken: "access", refreshToken: "refresh", idToken: "id", expiresIn: 3600, tokenType: "Bearer" } };
}

// backupPadiAction needs a real, decodable idToken (getPadiCredentials reads the
// `custom:affiliate_id` claim out of it) -- fakeTokens()'s plain "id" string isn't one, so this
// mirrors tests/integration/padi-sync.test.ts's own fakeIdToken helper instead.
function fakeTokensWithAffiliate(affiliateId: string) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ "custom:affiliate_id": affiliateId })).toString("base64url");
  return {
    tokens: {
      accessToken: "access",
      refreshToken: "refresh",
      idToken: `${header}.${payload}.signature`,
      expiresIn: 3600,
      tokenType: "Bearer",
    },
  };
}

async function loginAsNewUser() {
  const email = `padi-actions-${randomUUID()}@example.com`;
  const user = await createUser({ email, password: "a-long-enough-password" });
  await createSession(user.id);
  return user;
}

async function purgeOwnUsers() {
  await getTestPool().query("delete from users where email like 'padi-actions-%@example.com'");
}

beforeAll(async () => {
  await purgeOwnUsers();
});

beforeEach(() => {
  cookieStore.clear();
  loginMock.mockReset();
  saveIntegrationMock.mockReset();
  saveIntegrationMock.mockImplementation(realSavePadiIntegration);
  fetchLogbookPageMock.mockReset().mockResolvedValue({ data: { logbook_logs: [] } });
  fetchLogbookDetailMock.mockReset();
});

afterAll(async () => {
  await purgeOwnUsers();
  await closeTestPool();
});

describe("connectPadiAction", () => {
  // Direct regression test for the bug found during review: an unset PADI_USERNAME_HASH_PEPPER
  // must fail loudly (as an infrastructure error) rather than silently hashing usernames under an
  // empty/known key, which would defeat the whole point of hashing them.
  it("fails gracefully, without ever calling PADI, when PADI_USERNAME_HASH_PEPPER is unset", async () => {
    const user = await loginAsNewUser();
    loginMock.mockResolvedValue(fakeTokens());
    const previousPepper = process.env.PADI_USERNAME_HASH_PEPPER;
    delete process.env.PADI_USERNAME_HASH_PEPPER;

    try {
      const result = await connectPadiAction("diver@example.com", "hunter2");
      expect(result.ok).toBe(false);
      expect(loginMock).not.toHaveBeenCalled();

      const row = await getTestPool().query("select 1 from padi_integrations where user_id = $1", [user.id]);
      expect(row.rows).toHaveLength(0);
    } finally {
      process.env.PADI_USERNAME_HASH_PEPPER = previousPepper;
    }
  });

  it("saves an encrypted, connected integration on success", async () => {
    const user = await loginAsNewUser();
    loginMock.mockResolvedValue(fakeTokens());

    const result = await connectPadiAction("diver@example.com", "hunter2");
    expect(result).toEqual({ ok: true });

    const row = await getTestPool().query(
      "select status, needs_reconnect_at, access_token_encrypted from padi_integrations where user_id = $1",
      [user.id],
    );
    expect(row.rows[0].status).toBe("connected");
    expect(row.rows[0].needs_reconnect_at).toBeNull();
    expect(row.rows[0].access_token_encrypted).not.toBe("access");
  });

  it("records a failed attempt and returns a friendly error on invalid credentials, without ever mentioning the password", async () => {
    const user = await loginAsNewUser();
    loginMock.mockRejectedValue(new PadiApiError("PADI request failed with status 401", 401));

    const result = await connectPadiAction("diver@example.com", "super-secret-password");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).not.toContain("super-secret-password");

    const attempts = await getTestPool().query(
      "select count(*)::int as count from padi_login_attempts where user_id = $1",
      [user.id],
    );
    expect(attempts.rows[0].count).toBe(1);
  });

  // Direct regression test for the bug found during review: a successful PADI login followed by a
  // LOCAL failure (misconfigured encryption key, DB hiccup, etc.) must not be recorded as a failed
  // PADI login attempt -- the acceptance criterion is "only on a FAILED PADI login", and a local
  // failure isn't fixed by the user retrying with different credentials.
  it("does not record a failed attempt when PADI login succeeds but the local save fails", async () => {
    const user = await loginAsNewUser();
    loginMock.mockResolvedValue(fakeTokens());
    saveIntegrationMock.mockRejectedValueOnce(new Error("simulated local failure (e.g. bad encryption key)"));

    const result = await connectPadiAction("diver@example.com", "hunter2");
    expect(result.ok).toBe(false);
    expect(loginMock).toHaveBeenCalledTimes(1);

    const attempts = await getTestPool().query(
      "select count(*)::int as count from padi_login_attempts where user_id = $1",
      [user.id],
    );
    expect(attempts.rows[0].count).toBe(0);

    // No half-written row either.
    const row = await getTestPool().query("select 1 from padi_integrations where user_id = $1", [user.id]);
    expect(row.rows).toHaveLength(0);
  });

  it("rejects the 6th attempt within the window before ever calling PADI again", async () => {
    const user = await loginAsNewUser();
    loginMock.mockRejectedValue(new PadiApiError("PADI request failed with status 401", 401));

    for (let i = 0; i < 5; i += 1) {
      const result = await connectPadiAction("diver@example.com", "wrong");
      expect(result.ok).toBe(false);
    }
    expect(loginMock).toHaveBeenCalledTimes(5);

    const sixth = await connectPadiAction("diver@example.com", "wrong");
    expect(sixth.ok).toBe(false);
    // The rate limit must reject before calling PADI -- the mock's call count must not increase.
    expect(loginMock).toHaveBeenCalledTimes(5);

    void user;
  });
});

describe("disconnectPadiAction", () => {
  it("deletes the padi_integrations row for the current user", async () => {
    const user = await loginAsNewUser();
    loginMock.mockResolvedValue(fakeTokens());
    await connectPadiAction("diver@example.com", "hunter2");

    const result = await disconnectPadiAction();
    expect(result).toEqual({ ok: true });

    const row = await getTestPool().query("select 1 from padi_integrations where user_id = $1", [user.id]);
    expect(row.rows).toHaveLength(0);
  });
});

describe("syncPadiAction", () => {
  it("returns not_connected before touching PADI when the user has never connected", async () => {
    await loginAsNewUser();

    const result = await syncPadiAction();
    expect(result).toMatchObject({ ok: false, reason: "not_connected" });
  });
});

describe("backupPadiAction", () => {
  it("returns not_connected before touching PADI when the user has never connected", async () => {
    await loginAsNewUser();

    const result = await backupPadiAction();
    expect(result).toMatchObject({ ok: false, reason: "not_connected" });
  });

  it("downloads every dive in the logbook and records backup_done_at (issue #14)", async () => {
    const user = await loginAsNewUser();
    loginMock.mockResolvedValue(fakeTokensWithAffiliate("11223344"));
    await connectPadiAction("diver@example.com", "hunter2");

    fetchLogbookPageMock.mockResolvedValueOnce({
      data: { logbook_logs: [{ id: 901001 }, { id: 901002 }] },
    });
    fetchLogbookDetailMock.mockImplementation(async (_bearer: string, _affiliateId: string, id: number) => ({
      data: { logbook_logs: [{ id, dive_title: `Dive ${id}` }] },
    }));

    const result = await backupPadiAction();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.count).toBe(2);
    expect(JSON.parse(result.data).dives).toHaveLength(2);

    const row = await getTestPool().query<{ backup_done_at: Date | null }>(
      "select backup_done_at from padi_integrations where user_id = $1",
      [user.id],
    );
    expect(row.rows[0].backup_done_at).not.toBeNull();
  });
});

describe("dismissPadiBackupPromptAction", () => {
  it("records backup_prompt_dismissed_at for the current user, without touching backup_done_at", async () => {
    const user = await loginAsNewUser();
    loginMock.mockResolvedValue(fakeTokensWithAffiliate("11223344"));
    await connectPadiAction("diver@example.com", "hunter2");

    const result = await dismissPadiBackupPromptAction();
    expect(result).toEqual({ ok: true });

    const row = await getTestPool().query<{ backup_done_at: Date | null; backup_prompt_dismissed_at: Date | null }>(
      "select backup_done_at, backup_prompt_dismissed_at from padi_integrations where user_id = $1",
      [user.id],
    );
    expect(row.rows[0].backup_prompt_dismissed_at).not.toBeNull();
    expect(row.rows[0].backup_done_at).toBeNull();
  });
});
