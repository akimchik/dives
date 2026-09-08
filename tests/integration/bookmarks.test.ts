import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

// Integration test against a real Postgres (tests/integration/dives.test.ts's convention).
// Covers issue #6's core ownership requirement (AGENTS.md rule 10): a bookmark can only be
// created against, listed for, or deleted by the user who owns the underlying dive.
import { closeTestPool, getTestPool } from "./helpers/pg";

const { createBookmark, deleteBookmark, listBookmarks, BookmarkNotFoundError } = await import(
  "@/lib/bookmarks"
);
const { createDive } = await import("@/lib/dives");

type Owner = { id: string; email: string };

async function createOwner(): Promise<Owner> {
  const email = `bookmarks-${randomUUID()}@example.com`;
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

afterAll(async () => {
  await getTestPool().query("delete from users where email like 'bookmarks-%@example.com'");
  await closeTestPool();
});

describe("createBookmark", () => {
  it("creates a bookmark for a dive the user owns", async () => {
    const owner = await createOwner();
    const dive = await createDive(owner, diveInput());

    const bookmark = await createBookmark(owner.id, {
      diveId: dive.id,
      name: "Turtle sighting",
      selectedText: "Saw a hawksbill turtle near the coral wall.",
    });

    expect(bookmark.name).toBe("Turtle sighting");
    expect(bookmark.selected_text).toBe("Saw a hawksbill turtle near the coral wall.");
    expect(bookmark.dive_id).toBe(dive.id);
  });

  it("trims whitespace and truncates overlong name/text", async () => {
    const owner = await createOwner();
    const dive = await createDive(owner, diveInput());

    const bookmark = await createBookmark(owner.id, {
      diveId: dive.id,
      name: "  padded name  ",
      selectedText: `  ${"x".repeat(600)}  `,
    });

    expect(bookmark.name).toBe("padded name");
    expect(bookmark.selected_text).toHaveLength(500);
  });

  it("rejects an empty name or empty selected text", async () => {
    const owner = await createOwner();
    const dive = await createDive(owner, diveInput());

    await expect(
      createBookmark(owner.id, { diveId: dive.id, name: "   ", selectedText: "text" }),
    ).rejects.toThrow("Bookmark name is required");
    await expect(
      createBookmark(owner.id, { diveId: dive.id, name: "name", selectedText: "   " }),
    ).rejects.toThrow("Bookmarked text is required");
  });

  it("refuses to bookmark a dive owned by another user", async () => {
    const owner = await createOwner();
    const attacker = await createOwner();
    const dive = await createDive(owner, diveInput());

    await expect(
      createBookmark(attacker.id, { diveId: dive.id, name: "Not mine", selectedText: "text" }),
    ).rejects.toThrow(BookmarkNotFoundError);
  });
});

describe("listBookmarks", () => {
  it("returns only the requesting user's own bookmarks, with dive context", async () => {
    const owner = await createOwner();
    const other = await createOwner();
    const dive = await createDive(owner, diveInput({ title: "Wreck dive" }));
    const otherDive = await createDive(other, diveInput({ title: "Someone else's dive" }));

    await createBookmark(owner.id, { diveId: dive.id, name: "Mine", selectedText: "text one" });
    await createBookmark(other.id, { diveId: otherDive.id, name: "Not mine", selectedText: "text two" });

    const bookmarks = await listBookmarks(owner.id);

    expect(bookmarks).toHaveLength(1);
    expect(bookmarks[0]).toMatchObject({
      name: "Mine",
      selected_text: "text one",
      dive_id: dive.id,
      dive_title: "Wreck dive",
    });
  });
});

describe("deleteBookmark", () => {
  it("deletes a bookmark the user owns", async () => {
    const owner = await createOwner();
    const dive = await createDive(owner, diveInput());
    const bookmark = await createBookmark(owner.id, {
      diveId: dive.id,
      name: "Temp",
      selectedText: "text",
    });

    await deleteBookmark(owner.id, bookmark.id);

    expect(await listBookmarks(owner.id)).toHaveLength(0);
  });

  it("refuses to delete a bookmark owned by another user", async () => {
    const owner = await createOwner();
    const attacker = await createOwner();
    const dive = await createDive(owner, diveInput());
    const bookmark = await createBookmark(owner.id, {
      diveId: dive.id,
      name: "Mine",
      selectedText: "text",
    });

    await expect(deleteBookmark(attacker.id, bookmark.id)).rejects.toThrow(BookmarkNotFoundError);
    expect(await listBookmarks(owner.id)).toHaveLength(1);
  });
});
