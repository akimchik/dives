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

// Selects `needle` inside whichever single text node under `containerSelector` contains it whole
// -- mirrors what a real drag-select produces (one text node, one parent element), which is what
// BookmarkCapture's "sameElement" check requires.
async function selectTextInContainer(
  page: import("@playwright/test").Page,
  containerSelector: string,
  needle: string,
) {
  await page.evaluate(
    ({ containerSelector, needle }) => {
      const container = document.querySelector(containerSelector);
      if (!container) throw new Error(`container not found: ${containerSelector}`);

      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? "";
        const start = text.indexOf(needle);
        if (start === -1) continue;

        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + needle.length);

        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        return;
      }

      throw new Error(`"${needle}" not found in any single text node under ${containerSelector}`);
    },
    { containerSelector, needle },
  );
}

test.describe("dive bookmarks", () => {
  test("select text, bookmark it, then jump back to it from /bookmarks", async ({ page }) => {
    await registerViaMagicLink(page, uniqueTestEmail("bookmarks"), PASSWORD);
    const diveId = await logDiveWithNotes(page, "Afternoon reef dive");

    // Scroll down first, as a real user would before selecting text near the bottom of a long
    // dive page -- this is what exposed the position bug above.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await selectTextInContainer(page, "#dive-bookmark-scope", BOOKMARKED_WORD);

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

  // Regression coverage for a follow-up to issue #6: the title/subtitle heading and each profile
  // chart's caption line are separate DOM containers from the property/notes cards (the action
  // buttons and the chart's own SVG sit between them), so BookmarkCapture/TextFragmentHighlight
  // take a list of container ids rather than one -- this pins that the heading and the caption are
  // both actually in that list, not just the properties/notes cards already covered above.
  test("bookmark button also appears over the title/subtitle heading and a profile chart's caption", async ({
    page,
  }) => {
    await registerViaMagicLink(page, uniqueTestEmail("bookmarks-scope"), PASSWORD);
    await page.goto("/dives/new");
    await page.getByLabel("Title").fill("Wreck Explorer Special");
    await page.getByLabel("Date & time").fill("2026-08-14T09:15");
    await page.getByLabel("Depth profile").fill("0:00, 0\n3:00, 12.4\n18:00, 27.1\n25:00, 0");
    await page.getByRole("button", { name: "Log dive" }).click();
    await page.waitForURL(/\/dives\/\d+$/);
    await expect(page.getByRole("heading", { name: "Wreck Explorer Special" })).toBeVisible();

    await selectTextInContainer(page, "#dive-bookmark-scope-heading h1", "Explorer");
    await expect(page.getByTestId("bookmark-selection-button")).toBeVisible();

    // Selecting outside any bookmark-scope container (e.g. the site map or a chart's actual
    // SVG, neither of which is in BOOKMARK_CONTAINER_IDS) must NOT offer a bookmark button --
    // collapse the current selection first so the next assertion isn't just seeing a stale button.
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await expect(page.getByTestId("bookmark-selection-button")).toHaveCount(0);

    await selectTextInContainer(page, "#dive-bookmark-scope-caption", "samples");
    await expect(page.getByTestId("bookmark-selection-button")).toBeVisible();
  });
});
