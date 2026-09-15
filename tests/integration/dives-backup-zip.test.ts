import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";

import JSZip from "jszip";
import { afterAll, describe, expect, it } from "vitest";

// Integration test against a real Postgres (tests/integration/dives.test.ts's convention).
// Covers issue #16's backup zip: its contents, its handling of raw Suunto bundles (both real and
// the unreadable placeholder shape older rows/tests store), and -- the point of the whole file --
// AGENTS.md rule 10, that one user's archive can never contain another user's dive, site, bookmark
// or bundle.
import { closeTestPool, getTestPool } from "./helpers/pg";

const { buildDivesBackupZip } = await import("@/lib/backup/dives-zip");
const { createBookmark } = await import("@/lib/bookmarks");
const { createDive } = await import("@/lib/dives");

type Owner = { id: string; email: string };

async function createOwner(): Promise<Owner> {
  const email = `dives-backup-${randomUUID()}@example.com`;
  const result = await getTestPool().query<{ id: number }>(
    "insert into users (email, password_hash) values ($1, 'x') returning id",
    [email],
  );

  return { id: String(result.rows[0].id), email };
}

function diveInput(overrides: Record<string, unknown> = {}) {
  return {
    site: null,
    title: "Reef dive",
    occurredAt: "2026-08-09T07:30:00.000Z",
    maxDepth: null,
    avgDepth: null,
    bottomTimeMinutes: null,
    waterTemp: null,
    waterTempLow: null,
    airTemp: null,
    visibility: null,
    gasMix: null,
    tankInfo: null,
    cylinderSize: null,
    startPressure: null,
    endPressure: null,
    weight: null,
    weightFeedback: null,
    suitType: null,
    hood: null,
    gloves: null,
    boots: null,
    buddy: null,
    diveShop: null,
    current: null,
    surge: null,
    waves: null,
    weather: null,
    waterType: null,
    bodyOfWater: null,
    entryType: null,
    notes: "Saw a hawksbill turtle near the coral wall.",
    rating: null,
    depthProfile: null,
    depthProfileRaw: null,
    tags: [],
    ...overrides,
  };
}

// The real on-disk shape: gzip of `{ files: [{ path, contentBase64 }] }` (see
// lib/suunto/raw-bundle.ts and scripts/suunto-sidecar/server.mjs).
function realBundle(files: { path: string; content: string }[]): Buffer {
  return gzipSync(
    Buffer.from(
      JSON.stringify({
        files: files.map((file) => ({
          path: file.path,
          contentBase64: Buffer.from(file.content).toString("base64"),
        })),
      }),
    ),
  );
}

// Inserts a dive carrying a raw bundle blob directly -- createDive deliberately can't write
// suunto_original_bundle (it's excluded from DiveInput/snapshotColumns by design).
async function insertDiveWithBundle(owner: Owner, bundle: Buffer, title: string): Promise<number> {
  const result = await getTestPool().query<{ id: number }>(
    `
      insert into dives (user_id, title, occurred_at, suunto_workout_key, suunto_original_bundle)
      values ($1, $2, now(), $3, $4)
      returning id
    `,
    [owner.id, title, `workout-${randomUUID()}`, bundle],
  );

  return result.rows[0].id;
}

async function readZip(userId: string) {
  const zip = await JSZip.loadAsync(await buildDivesBackupZip(userId));

  async function json(path: string): Promise<unknown> {
    const file = zip.file(path);
    if (!file) throw new Error(`zip has no "${path}"`);
    return JSON.parse(await file.async("string"));
  }

  return { zip, json, paths: Object.keys(zip.files) };
}

afterAll(async () => {
  await getTestPool().query("delete from users where email like 'dives-backup-%@example.com'");
  await closeTestPool();
});

describe("buildDivesBackupZip", () => {
  it("writes dives.json, dive_sites.json and bookmarks.json with the user's own data", async () => {
    const owner = await createOwner();
    const dive = await createDive(owner, diveInput({ site: { name: "Blue Hole", location: "Gozo" } }));
    await createBookmark(owner.id, {
      diveId: dive.id,
      name: "Turtle sighting",
      selectedText: "Saw a hawksbill turtle near the coral wall.",
    });

    const { json } = await readZip(owner.id);

    const dives = (await json("dives.json")) as { id: number; title: string; site_name: string }[];
    expect(dives).toHaveLength(1);
    expect(dives[0]).toMatchObject({ id: dive.id, title: "Reef dive", site_name: "Blue Hole" });

    const sites = (await json("dive_sites.json")) as { name: string; location: string }[];
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ name: "Blue Hole", location: "Gozo" });

    const bookmarks = (await json("bookmarks.json")) as { name: string; dive_id: number }[];
    expect(bookmarks).toHaveLength(1);
    expect(bookmarks[0]).toMatchObject({ name: "Turtle sighting", dive_id: dive.id });
  });

  // Regression coverage for issue #27's lean-columns fix: listDives now nulls out suunto_profile
  // for the UI list views, and buildDivesBackupZip must keep using the separate full-column
  // listDivesForBackup so the backup export doesn't silently lose it too.
  it("keeps a dive's full suunto_profile in dives.json", async () => {
    const owner = await createOwner();
    const profile = { source: "suunto", version: 1, workoutKey: `workout-${randomUUID()}` };
    const result = await getTestPool().query<{ id: number }>(
      `
        insert into dives (user_id, title, occurred_at, suunto_workout_key, suunto_profile)
        values ($1, $2, now(), $3, $4)
        returning id
      `,
      [owner.id, "Suunto dive", profile.workoutKey, JSON.stringify(profile)],
    );
    const diveId = result.rows[0].id;

    const { json } = await readZip(owner.id);
    const dives = (await json("dives.json")) as { id: number; suunto_profile: unknown }[];
    const dive = dives.find((row) => row.id === diveId);
    expect(dive?.suunto_profile).toMatchObject(profile);
  });

  it("is empty-but-valid for a user with no dives at all", async () => {
    const owner = await createOwner();
    const { json } = await readZip(owner.id);

    expect(await json("dives.json")).toEqual([]);
    expect(await json("dive_sites.json")).toEqual([]);
    expect(await json("bookmarks.json")).toEqual([]);
  });

  it("unpacks a real Suunto bundle under suunto/<diveId>/", async () => {
    const owner = await createOwner();
    const diveId = await insertDiveWithBundle(
      owner,
      realBundle([
        { path: "workout.sml.json", content: '{"Data":{"Header":{"Depth":12.3}}}' },
        { path: "samples/raw.txt", content: "sample-bytes" },
      ]),
      "Suunto dive",
    );

    const { zip, paths } = await readZip(owner.id);

    expect(paths).toContain(`suunto/${diveId}/workout.sml.json`);
    expect(paths).toContain(`suunto/${diveId}/samples/raw.txt`);
    await expect(zip.file(`suunto/${diveId}/samples/raw.txt`)!.async("string")).resolves.toBe("sample-bytes");
    await expect(zip.file(`suunto/${diveId}/workout.sml.json`)!.async("string")).resolves.toBe(
      '{"Data":{"Header":{"Depth":12.3}}}',
    );
  });

  it("skips an unreadable (non-gzip placeholder) bundle without failing the whole backup", async () => {
    const owner = await createOwner();
    // The placeholder shape tests/integration/dives.test.ts's stageSuunto helper stores.
    const brokenId = await insertDiveWithBundle(owner, Buffer.from("bundle:not-a-real-export"), "Broken");
    const goodId = await insertDiveWithBundle(
      owner,
      realBundle([{ path: "workout.sml.json", content: "{}" }]),
      "Good",
    );

    const { json, paths } = await readZip(owner.id);

    // The backup still succeeds, still lists both dives, and just omits the unreadable one's files.
    expect((await json("dives.json")) as unknown[]).toHaveLength(2);
    expect(paths).toContain(`suunto/${goodId}/workout.sml.json`);
    expect(paths.some((path) => path.startsWith(`suunto/${brokenId}/`))).toBe(false);
  });

  it("never leaks another user's dives, sites, bookmarks or bundles (AGENTS.md rule 10)", async () => {
    const alice = await createOwner();
    const bob = await createOwner();

    const aliceDive = await createDive(alice, diveInput({ site: { name: "Alice Reef" }, title: "Alice dive" }));
    await createBookmark(alice.id, {
      diveId: aliceDive.id,
      name: "Alice bookmark",
      selectedText: "Saw a hawksbill turtle near the coral wall.",
    });

    const bobDive = await createDive(bob, diveInput({ site: { name: "Bob Reef" }, title: "Bob dive" }));
    await createBookmark(bob.id, {
      diveId: bobDive.id,
      name: "Bob bookmark",
      selectedText: "Saw a hawksbill turtle near the coral wall.",
    });
    const bobBundleDiveId = await insertDiveWithBundle(
      bob,
      realBundle([{ path: "workout.sml.json", content: '{"secret":"bob"}' }]),
      "Bob suunto dive",
    );

    const { zip, json, paths } = await readZip(alice.id);

    const dives = (await json("dives.json")) as { id: number; title: string }[];
    expect(dives.map((dive) => dive.title)).toEqual(["Alice dive"]);
    expect(dives.map((dive) => dive.id)).not.toContain(bobDive.id);

    expect(((await json("dive_sites.json")) as { name: string }[]).map((site) => site.name)).toEqual(["Alice Reef"]);
    expect(((await json("bookmarks.json")) as { name: string }[]).map((b) => b.name)).toEqual(["Alice bookmark"]);

    // Bob's bundle must not appear under any path, and its bytes must not be anywhere in the archive.
    expect(paths.some((path) => path.startsWith(`suunto/${bobBundleDiveId}/`))).toBe(false);
    expect(paths.filter((path) => path.startsWith("suunto/"))).toEqual([]);

    const wholeArchive = await zip.generateAsync({ type: "nodebuffer" });
    expect(wholeArchive.includes(Buffer.from('"secret":"bob"'))).toBe(false);
    expect(wholeArchive.includes(Buffer.from("Bob dive"))).toBe(false);
  });

  it("returns no bundle files for a dive whose bundle belongs to another user's id space", async () => {
    const alice = await createOwner();
    const bob = await createOwner();
    await insertDiveWithBundle(bob, realBundle([{ path: "workout.sml.json", content: "{}" }]), "Bob only");

    const { paths } = await readZip(alice.id);

    expect(paths).toEqual(["dives.json", "dive_sites.json", "bookmarks.json"]);
  });
});
