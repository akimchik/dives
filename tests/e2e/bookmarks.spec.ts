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
// A shorter-than-default viewport forces real scrolling to reach the Notes card below it -- a
// regression test for the button-position bug (issue #6 follow-up) where the floating "Bookmark"
// button was positioned as if `position: absolute` (adding window.scrollY/scrollX to an
// already-viewport-relative getBoundingClientRect()) while actually being `position: fixed`,
// pushing it further off-screen the more the page was scrolled. The default "Desktop Safari"
// viewport is tall enough that this minimal test dive fits without scrolling at all, which is
// exactly why that bug shipped unnoticed: window.scrollY was always 0.
test.use({ viewport: { width: 1280, height: 400 } });

const PASSWORD = "a-long-enough-password-123";
// Filler pads the page past the 400px viewport height above -- neither alone is enough: the short
// notes text alone doesn't push the page past even a 400px viewport, and the filler alone doesn't
// push it past the *default* ~720px viewport (which is why the original bug shipped unnoticed).
const FILLER = "Uneventful stretch of the dive with nothing notable to record here. ".repeat(30);
const NOTES = `${FILLER}Saw a hawksbill turtle near the coral wall.`;
const BOOKMARKED_WORD = "hawksbill";

async function logDiveWithNotes(page: import("@playwright/test").Page, title: string) {
  await page.goto("/dives/new");
  await page.getByLabel("Title").pressSequentially(title);
  await page.getByLabel("Date & time").fill("2026-08-14T09:15");
  // fill(), not pressSequentially(): the filler text below is long enough (~2000 chars) that
  // typing it character-by-character was slow enough to time out on CI's shared runners.
  await page.getByLabel("Notes").fill(NOTES);
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

    // Scroll down first, as a real user would before selecting text near the bottom of a long
    // dive page -- this is what exposed the position bug above.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await selectWordInNotes(page, BOOKMARKED_WORD);

    const bookmarkButton = page.getByTestId("bookmark-selection-button");
    await expect(bookmarkButton).toBeVisible();
    const viewport = page.viewportSize();
    const buttonBox = await bookmarkButton.boundingBox();
    expect(buttonBox).not.toBeNull();
    expect(viewport).not.toBeNull();
    // Must land inside the visible viewport, not merely be "visible" in Playwright's sense (which
    // only checks for a non-zero box, not that it's on-screen) -- an element positioned hundreds
    // of pixels below the viewport still passes toBeVisible().
    expect(buttonBox!.y).toBeGreaterThanOrEqual(0);
    expect(buttonBox!.y).toBeLessThan(viewport!.height);
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
