import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Integration test for app/actions/auth.ts's completeRegistrationAction, run against a real
// Postgres (helpers/pg.ts resolves TEST_DATABASE_URL ?? DATABASE_URL). Server actions touch
// next/headers (cookies) and next/navigation (redirect) which only exist inside a real
// Next.js request — both are mocked here so the action's actual DB/session logic runs for
// real while framework plumbing is stubbed. Each case uses a fresh random email so it stays
// collision-safe against the shared database.
import { closeTestPool } from "./helpers/pg";

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

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

const { createMagicLinkToken } = await import("@/lib/magic-link");
const { completeRegistrationAction } = await import("@/app/actions/auth");
const { createUser, findActiveUserByEmail } = await import("@/lib/users");

async function countUsersByEmail(email: string) {
  const user = await findActiveUserByEmail(email);
  return user ? 1 : 0;
}

function expectRedirectTo(action: () => Promise<unknown>, target: string) {
  return expect(action()).rejects.toThrow(`REDIRECT:${target}`);
}

afterAll(async () => {
  await closeTestPool();
});

beforeEach(() => {
  cookieStore.clear();
});

describe("completeRegistrationAction", () => {
  it("creates an account and session, then redirects to /dashboard on a fresh valid token", async () => {
    const email = `${randomUUID()}@example.com`;
    const { token } = await createMagicLinkToken(email);

    await expectRedirectTo(() => completeRegistrationAction(token, "a-long-enough-password"), "/dashboard");

    expect(await countUsersByEmail(email)).toBe(1);
    expect(cookieStore.size).toBeGreaterThan(0);
  });

  it("consumes the token exactly once: a second attempt with the same token errors instead of duplicating the account", async () => {
    const email = `${randomUUID()}@example.com`;
    const { token } = await createMagicLinkToken(email);

    await expectRedirectTo(() => completeRegistrationAction(token, "a-long-enough-password"), "/dashboard");

    const secondAttempt = await completeRegistrationAction(token, "a-different-password");

    expect(secondAttempt).toMatchObject({ error: expect.any(String) });
    expect(await countUsersByEmail(email)).toBe(1);
  });

  it("returns a friendly error, not a crash, when the account was created between issuance and consumption", async () => {
    const email = `${randomUUID()}@example.com`;
    const { token } = await createMagicLinkToken(email);

    // Simulate a second concurrent registration flow completing first.
    await createUser({ email, password: "someone-elses-password" });

    const result = await completeRegistrationAction(token, "a-long-enough-password");

    expect(result).toMatchObject({ error: expect.any(String) });
    expect(await countUsersByEmail(email)).toBe(1);
  });

  it("returns an error for an unknown token without throwing", async () => {
    const result = await completeRegistrationAction("not-a-real-token", "a-long-enough-password");

    expect(result).toMatchObject({ error: expect.any(String) });
  });
});
