import { expect, test } from "@playwright/test";

import { registerViaMagicLink } from "./helpers/auth";
import { uniqueTestEmail } from "./helpers/db";

// End-to-end coverage for issue #19: tagging a dive through the form's TagsField, the tag cloud +
// ?tag= filter on /dives, and the compact tag cloud on /dashboard. missing-padi/missing-suunto
// aren't covered here since they require a connected PADI/Suunto integration (OAuth), which is out
// of reach for this suite -- lib/tags.ts's effectiveTags()/buildTagCloud() are unit-tested directly
// for that, and lib/dives.ts's listUserTags() is integration-tested against a real Postgres.

const PASSWORD = "a-long-enough-password-123";

async function addTag(page: import("@playwright/test").Page, tag: string) {
  const input = page.getByLabel("Tags", { exact: true });
  await input.pressSequentially(tag);
  await input.press("Enter");
}

async function logDive(page: import("@playwright/test").Page, title: string, tags: string[]) {
  await page.goto("/dives/new");
  await page.getByLabel("Title").pressSequentially(title);
  await page.getByLabel("Date & time").fill("2026-08-14T09:15");
  for (const tag of tags) {
    await addTag(page, tag);
  }
  await page.getByRole("button", { name: "Log dive" }).click();
  await page.waitForURL(/\/dives\/\d+$/);
  // Wait for the detail page to actually render before any caller navigates away -- otherwise a
  // goto() right after waitForURL can race the client-side push and get self-interrupted.
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
}

test.describe("dive tags", () => {
  test("tag chip input adds/removes tags, normalizes casing, and refuses reserved names", async ({ page }) => {
    await registerViaMagicLink(page, uniqueTestEmail("tags-input"), PASSWORD);
    await page.goto("/dives/new");

    await addTag(page, "Night Dive");
    await expect(page.getByText("night dive", { exact: true })).toBeVisible();

    // Reserved: refused with a toast, never added as a chip.
    await addTag(page, "missing-padi");
    await expect(page.getByText(/reserved tag/i)).toBeVisible();
    await expect(page.getByLabel("Remove tag missing-padi")).toHaveCount(0);

    await addTag(page, "shark");
    await expect(page.getByLabel("Remove tag shark")).toBeVisible();
    await page.getByLabel("Remove tag shark").click();
    await expect(page.getByLabel("Remove tag shark")).toHaveCount(0);
  });

  test("tag cloud on /dives filters the list without renumbering, and dashboard shows a matching cloud", async ({
    page,
  }) => {
    await registerViaMagicLink(page, uniqueTestEmail("tags-cloud"), PASSWORD);

    await logDive(page, "Morning wreck dive", ["wreck", "cold-water"]);
    await logDive(page, "Afternoon reef dive", ["reef"]);

    await page.goto("/dives");
    const tagCloud = page.getByTestId("tag-cloud");
    await expect(tagCloud.getByText("wreck")).toBeVisible();
    await expect(tagCloud.getByText("reef")).toBeVisible();

    // Oldest-first numbering: "Morning wreck dive" was logged first, so it's #1 even though it's
    // NOT first in the newest-first list -- both dives share a date/time, so list order is by id.
    const list = page.getByTestId("dive-list");
    await expect(list.getByRole("listitem").filter({ hasText: "Morning wreck dive" })).toContainText("#1");

    await tagCloud.getByText("wreck").click();
    await expect(page).toHaveURL(/\?tag=wreck$/);
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await expect(list).toContainText("Morning wreck dive");
    await expect(list).not.toContainText("Afternoon reef dive");
    // Filtering must not renumber: still #1, the same as unfiltered.
    await expect(list.getByRole("listitem").filter({ hasText: "Morning wreck dive" })).toContainText("#1");

    await page.goto("/dashboard");
    await expect(page.getByTestId("dashboard-tag-cloud").getByText("wreck")).toBeVisible();
  });

  test("editing a dive updates its tags", async ({ page }) => {
    await registerViaMagicLink(page, uniqueTestEmail("tags-edit"), PASSWORD);
    await logDive(page, "Cenote exploration", ["swimthrough"]);

    const diveUrl = page.url();
    await page.goto(`${diveUrl}/edit`);
    await expect(page.getByLabel("Remove tag swimthrough")).toBeVisible();
    await page.getByLabel("Remove tag swimthrough").click();
    await addTag(page, "night-dive");
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.waitForURL(/\/dives\/\d+$/);
    await expect(page.getByRole("heading", { name: "Cenote exploration" })).toBeVisible();
    // The edit save's router.refresh() can still have a background RSC fetch in flight here; an
    // immediate goto() below can race and self-interrupt it (WebKit only). Settling first avoids it.
    await page.waitForLoadState("networkidle");

    await page.goto("/dives");
    const row = page.getByTestId("dive-list").getByRole("listitem").filter({ hasText: "Cenote exploration" });
    await expect(row).toContainText("night-dive");
    await expect(row).not.toContainText("swimthrough");
  });
});
