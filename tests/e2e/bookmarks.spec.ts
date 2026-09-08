import { expect, test } from "@playwright/test";

import { registerViaMagicLink } from "./helpers/auth";
import { uniqueTestEmail } from "./helpers/db";

// End-to-end coverage for issue #6: selecting a piece of a dive's notes, bookmarking it, and
// jumping back to it -- highlighted -- from /bookmarks. The selection itself is made via a
// scripted Range/Selection (page.evaluate) rather than a mouse drag or double-click: a real drag
// would still land on the same selectionchange-driven code path the app runs in production, but
// is inherently word-boundary-dependent and flaky to aim precisely, where BookmarkCapture's
// selectionchange listener is exactly what's under test here, not the mouse.
//
// The highlight itself is this app's own (components/text-fragment-highlight.tsx), not the
// browser's native "Scroll To Text Fragment" handling of the `:~:text=` half of the URL: real
// Safari and this project's own Playwright WebKit build both discard that directive without ever
// highlighting anything (see lib/text-fragment.ts's file comment), so a bookmark-text= fragment
// segment ahead of it is what this app actually reads back and acts on.
const PASSWORD = "a-long-enough-password-123";
const NOTES = "Saw a hawksbill turtle near the coral wall.";
const BOOKMARKED_WORD = "hawksbill";

async function logDiveWithNotes(page: import("@playwright/test").Page, title: string) {
  await page.goto("/dives/new");
  await page.getByLabel("Title").pressSequentially(title);
  await page.getByLabel("Date & time").fill("2026-08-14T09:15");
  await page.getByLabel("Notes").pressSequentially(NOTES);
  await page.getByRole("button", { name: "Log dive" }).click();
  await page.waitForURL(/\/dives\/\d+$/);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();

  const url = page.url();
  const diveId = Number(url.match(/\/dives\/(\d+)$/)?.[1]);
  return diveId;
}

async function selectWordInNotes(page: import("@playwright/test").Page, word: string) {
  await page.evaluate((needle) => {
    const container = document.getElementById("dive-bookmark-scope");
    const paragraph = container?.querySelector("p");
    const textNode = paragraph?.firstChild;
    if (!textNode || !textNode.textContent) throw new Error("notes text node not found");

    const start = textNode.textContent.indexOf(needle);
    if (start === -1) throw new Error("needle not found in notes text");

    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, start + needle.length);

    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, word);
}

test.describe("dive bookmarks", () => {
  test("select text, bookmark it, then jump back to it from /bookmarks", async ({ page }) => {
    await registerViaMagicLink(page, uniqueTestEmail("bookmarks"), PASSWORD);
    const diveId = await logDiveWithNotes(page, "Afternoon reef dive");

    await selectWordInNotes(page, BOOKMARKED_WORD);

    const bookmarkButton = page.getByTestId("bookmark-selection-button");
    await expect(bookmarkButton).toBeVisible();
    await bookmarkButton.click();

    await expect(page.getByRole("dialog", { name: "Bookmark this text" })).toBeVisible();
    const nameInput = page.getByLabel("Name");
    await expect(nameInput).toHaveValue(BOOKMARKED_WORD);
    await nameInput.fill("Turtle sighting");
    await page.getByRole("button", { name: "Save bookmark" }).click();
    await expect(page.getByText("Bookmarked.")).toBeVisible();

    await page.goto("/bookmarks");
    const bookmarkRow = page.getByTestId("bookmark-row").filter({ hasText: "Turtle sighting" });
    await expect(bookmarkRow).toBeVisible();
    await expect(bookmarkRow).toContainText("Afternoon reef dive");
    await expect(bookmarkRow).toContainText(BOOKMARKED_WORD);

    const bookmarkLink = bookmarkRow.getByTestId("bookmark-link");
    await expect(bookmarkLink).toHaveAttribute(
      "href",
      `/dives/${diveId}#bookmark-text=${BOOKMARKED_WORD}:~:text=${BOOKMARKED_WORD}`,
    );

    await bookmarkLink.click();
    await page.waitForURL(new RegExp(`/dives/${diveId}`));
    await expect(page.getByRole("heading", { name: "Afternoon reef dive" })).toBeVisible();

    const highlight = page.getByTestId("bookmark-highlight");
    await expect(highlight).toBeVisible();
    await expect(highlight).toHaveText(BOOKMARKED_WORD);

    // Deleting it from /bookmarks removes it from the list.
    await page.goto("/bookmarks");
    await page
      .getByTestId("bookmark-row")
      .filter({ hasText: "Turtle sighting" })
      .getByRole("button", { name: "Delete bookmark" })
      .click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByText("Bookmark deleted.")).toBeVisible();
    await expect(page.getByTestId("bookmark-row")).toHaveCount(0);
  });
});
