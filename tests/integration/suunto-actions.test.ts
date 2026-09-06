import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

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

const suuntoLoginMock = vi.fn();
const listSuuntoWorkoutsMock = vi.fn();
const exportSuuntoWorkoutMock = vi.fn();
vi.mock("@/lib/suunto/sidecar-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/suunto/sidecar-client")>();
  return {
    ...actual,
    suuntoLogin: (...args: unknown[]) => suuntoLoginMock(...args),
    listSuuntoWorkouts: (...args: unknown[]) => listSuuntoWorkoutsMock(...args),
    exportSuuntoWorkout: (...args: unknown[]) => exportSuuntoWorkoutMock(...args),
  };
});

const TEST_KEY_BASE64 = Buffer.from("2".repeat(32)).toString("base64");
process.env.SUUNTO_SESSION_ENCRYPTION_KEY = TEST_KEY_BASE64;
process.env.SUUNTO_EMAIL_HASH_PEPPER = "suunto-action-test-pepper";
process.env.SUUNTO_SIDECAR_URL = "http://127.0.0.1:4817";

const { createSession } = await import("@/lib/session");
const { createUser } = await import("@/lib/users");
const { connectSuuntoAction, fetchSuuntoWorkoutsAction } = await import("@/app/actions/suunto");
const { stageSuuntoImport } = await import("@/lib/suunto/imports");

async function loginAsNewUser() {
  const email = `suunto-actions-${randomUUID()}@aleksandr.vin`;
  const user = await createUser({ email, password: "a-long-enough-password" });
  await createSession(user.id);
  return user;
}

function smlFixture(workoutKey: string) {
  return {
    Data: {
      Samples: [
        {
          TimeISO8601: "2026-08-30T10:40:08.250+02:00",
          Attributes: { "suunto/sml": { Sample: { Depth: 1, Cylinders: [{ Pressure: 19000000 }] } } },
        },
        {
          TimeISO8601: "2026-08-30T10:41:08.250+02:00",
          Attributes: {
            "suunto/sml": { Sample: { Depth: 8, Temperature: 293.15, Cylinders: [{ Pressure: 17000000 }] } },
          },
        },
      ],
    },
    Summary: {
      Samples: [
        {
          Attributes: {
            "suunto/sml": {
              DiveHeader: { Gases: [{ Oxygen: 21, TankFillPressure: 21000000, TankSize: 0.012 }] },
              DiveFooter: { Gases: [{ StartPressure: 19000000, EndPressure: 12000000 }] },
              Windows: [{ DiveTime: 1800, Depth: [{ Max: 8, Avg: 4 }], Temperature: [{ Avg: 293.15 }] }],
            },
          },
        },
      ],
    },
    _fixtureKey: workoutKey,
  };
}

async function purgeOwnUsers() {
  await getTestPool().query("delete from users where email like 'suunto-actions-%@aleksandr.vin'");
}

beforeEach(() => {
  cookieStore.clear();
  suuntoLoginMock.mockReset();
  listSuuntoWorkoutsMock.mockReset();
  exportSuuntoWorkoutMock.mockReset();
});

afterAll(async () => {
  await purgeOwnUsers();
  await closeTestPool();
});

describe("Suunto server actions", () => {
  it("connects with a password without storing it, then reuses the persisted session for fetch", async () => {
    const user = await loginAsNewUser();
    suuntoLoginMock.mockResolvedValue({ sessionJson: "{\"session\":\"secret\"}" });

    const connected = await connectSuuntoAction("diver@aleksandr.vin", "do-not-store-me");
    expect(connected).toEqual({ ok: true });
    expect(suuntoLoginMock).toHaveBeenCalledWith("diver@aleksandr.vin", "do-not-store-me");

    const integration = await getTestPool().query(
      "select session_encrypted from suunto_integrations where user_id = $1",
      [user.id],
    );
    expect(integration.rows[0].session_encrypted).not.toContain("secret");
    expect(integration.rows[0].session_encrypted).not.toContain("do-not-store-me");

    listSuuntoWorkoutsMock.mockResolvedValue({ workouts: [] });
    const fetched = await fetchSuuntoWorkoutsAction(3);
    expect(fetched).toMatchObject({ ok: true, checked: 0, staged: 0 });
    expect(listSuuntoWorkoutsMock).toHaveBeenCalledWith('{"session":"secret"}', 3);
  });

  it("skips already staged/saved workout ids before exporting new workouts", async () => {
    const user = await loginAsNewUser();
    suuntoLoginMock.mockResolvedValue({ sessionJson: "{\"session\":\"fetch\"}" });
    await connectSuuntoAction("diver@aleksandr.vin", "correct-password");

    const alreadyStagedKey = `already-staged-${randomUUID()}`;
    const alreadySavedKey = `already-saved-${randomUUID()}`;
    const newKey = `new-${randomUUID()}`;
    await stageSuuntoImport(user.id, {
      workoutKey: alreadyStagedKey,
      workoutStartedAt: "2026-08-30T08:40:08.250Z",
      summary: {},
      draftDive: {},
      compiledProfile: {
        source: "suunto",
        version: 1,
        workoutKey: alreadyStagedKey,
        startedAt: "2026-08-30T08:40:08.250Z",
        durationMinutes: 30,
        maxDepth: 8,
        averageDepth: 4,
        waterTemperature: 20,
        waterTemperatureLow: 20,
        tankStartPressure: 190,
        tankEndPressure: 120,
        tankSizeLitres: 12,
        gasMix: "Air",
        location: null,
        points: [],
        depthProfile: [],
        summary: {},
      },
      originalBundle: Buffer.from("staged"),
    });
    await getTestPool().query(
      "insert into dives (user_id, title, occurred_at, suunto_workout_key) values ($1, 'saved', now(), $2)",
      [user.id, alreadySavedKey],
    );

    listSuuntoWorkoutsMock.mockResolvedValue({
      workouts: [{ key: alreadyStagedKey }, { key: alreadySavedKey }, { key: newKey }],
    });
    exportSuuntoWorkoutMock.mockResolvedValue({
      bundleBase64: Buffer.from("bundle").toString("base64"),
      bundleEncoding: "json-files+gzip+base64",
      workoutJson: { key: newKey },
      workoutSmlJson: smlFixture(newKey),
    });

    const fetched = await fetchSuuntoWorkoutsAction(5);
    expect(fetched).toMatchObject({
      ok: true,
      checked: 3,
      staged: 1,
      alreadyStaged: 1,
      alreadySaved: 1,
      failedExports: 0,
    });
    expect(exportSuuntoWorkoutMock).toHaveBeenCalledTimes(1);
    expect(exportSuuntoWorkoutMock).toHaveBeenCalledWith('{"session":"fetch"}', newKey);
  });
});
