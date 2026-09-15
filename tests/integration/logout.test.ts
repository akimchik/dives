import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

// Regression coverage for a bug caught in code review while building issue #26's action metrics:
// logoutAction briefly read the session via getOptionalUser() (to label the metric with who
// logged out) *before* calling deleteSession(). getOptionalUser() clears the session cookie
// itself whenever the row is expired or its user is inactive -- Next's mutable cookie jar rewrites
// a deleted cookie's value to "" rather than removing it, so deleteSession()'s own subsequent
// cookieStore.get(...)?.value read back "" (falsy) and silently skipped the DB delete and the
// Authentik RP-initiated logout entirely. Fixed by having deleteSession() itself resolve and
// return the departing user from the same deleted row, with no separate pre-read. These tests
// pin deleteSession()'s reap-and-report behavior directly, including for an already-expired
// session, since that's exactly the case where the bug was invisible on a normal, fresh login.
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

const { createSession, deleteSession } = await import("@/lib/session");
const { createUser } = await import("@/lib/users");
const { logoutAction } = await import("@/app/actions/auth");

async function newUser() {
  const email = `logout-${randomUUID()}@aleksandr.vin`;
  return createUser({ email, password: "a-long-enough-password" });
}

async function expireSessionsFor(userId: string) {
  await getTestPool().query("update user_sessions set expires_at = now() - interval '1 day' where user_id = $1", [
    userId,
  ]);
}

async function sessionCountFor(userId: string) {
  const result = await getTestPool().query<{ count: string }>(
    "select count(*)::text as count from user_sessions where user_id = $1",
    [userId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

afterAll(async () => {
  await closeTestPool();
});

beforeEach(() => {
  cookieStore.clear();
});

describe("deleteSession", () => {
  it("reaps an active session and returns its user", async () => {
    const user = await newUser();
    await createSession(user.id);

    const { idToken, user: deletedUser } = await deleteSession();

    expect(idToken).toBeNull();
    expect(deletedUser?.id).toBe(user.id);
    expect(await sessionCountFor(user.id)).toBe(0);
    expect(cookieStore.size).toBe(0);
  });

  it("still reaps an already-expired session and returns its user, rather than leaving the row orphaned", async () => {
    const user = await newUser();
    await createSession(user.id);
    await expireSessionsFor(user.id);

    const { user: deletedUser } = await deleteSession();

    expect(deletedUser?.id).toBe(user.id);
    expect(await sessionCountFor(user.id)).toBe(0);
  });

  it("returns a null user and idToken when there is no session cookie at all", async () => {
    const result = await deleteSession();
    expect(result).toEqual({ idToken: null, user: null });
  });
});

describe("logoutAction", () => {
  it("deletes the session and redirects home for a normal password session", async () => {
    const user = await newUser();
    await createSession(user.id);

    await expect(logoutAction()).rejects.toThrow("REDIRECT:/");
    expect(await sessionCountFor(user.id)).toBe(0);
  });

  it("still deletes an already-expired session's row on logout instead of leaving it behind", async () => {
    const user = await newUser();
    await createSession(user.id);
    await expireSessionsFor(user.id);

    await expect(logoutAction()).rejects.toThrow("REDIRECT:/");
    expect(await sessionCountFor(user.id)).toBe(0);
  });
});
