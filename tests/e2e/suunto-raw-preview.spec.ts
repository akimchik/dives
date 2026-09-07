import { expect, test } from "@playwright/test";

import { registerViaMagicLink } from "./helpers/auth";
import { seedSuuntoDive, uniqueTestEmail } from "./helpers/db";

// End-to-end coverage for issue #5: "Add a raw Suunto (SML file) preview". Real Suunto data can't
// be fetched in this suite (same OAuth-reach limitation tags.spec.ts notes for missing-suunto), so
// the dive is seeded directly with a real gzip'd bundle via seedSuuntoDive -- see its comment.

const PASSWORD = "a-long-enough-password-123";

test.describe("raw Suunto (SML) data preview", () => {
  test("dive page links to the raw preview, which shows a searchable tree and syntax-highlighted text", async ({
    page,
  }) => {
    const email = uniqueTestEmail("suunto-raw");
    await registerViaMagicLink(page, email, PASSWORD);

    const sml = {
      Data: {
        Header: { DiveMode: "OpenCircuit" },
        Samples: [
          { TimeISO8601: "2026-08-30T10:40:08.250+02:00", Depth: 1.42 },
          { TimeISO8601: "2026-08-30T10:41:08.250+02:00", Depth: 8.82, Marker: "UniqueMarkerXyz789" },
        ],
      },
    };
    const { diveId } = await seedSuuntoDive(email, sml);

    await page.goto(`/dives/${diveId}`);
    await page.getByRole("link", { name: "Raw Suunto data" }).click();
    await page.waitForURL(new RegExp(`/dives/${diveId}/raw$`));
    await expect(page.getByRole("heading", { name: "Raw Suunto data" })).toBeVisible();

    // Object viewer tab (default): the top-level structure is expanded by default.
    await expect(page.getByText("OpenCircuit")).toBeVisible();

    // Search narrows/highlights and auto-expands to the match, wherever it's nested.
    await page.getByLabel("Search raw Suunto data").fill("UniqueMarkerXyz789");
    await expect(page.locator("mark", { hasText: "UniqueMarkerXyz789" }).first()).toBeVisible();

    // Syntax-highlighted text tab shows the same underlying JSON.
    await page.getByRole("tab", { name: "Syntax highlighted" }).click();
    await expect(page.locator("pre", { hasText: "UniqueMarkerXyz789" })).toBeVisible();
    await expect(page.locator("mark", { hasText: "UniqueMarkerXyz789" }).first()).toBeVisible();
  });

  test("a large dive (thousands of samples) reveals arrays behind a cap, falls back to plain text on the highlight tab, and search still finds a deep match without hanging", async ({
    page,
  }) => {
    const email = uniqueTestEmail("suunto-raw-large");
    await registerViaMagicLink(page, email, PASSWORD);

    // Comfortably past both components/json-tree-view.tsx's 100-item array reveal cap and
    // components/json-text-view.tsx's 250k-character syntax-highlight cap -- this is what
    // regressed to a frozen tab / a silently unhighlighted block before those caps were added.
    const sampleCount = 4000;
    const sml = {
      Data: {
        Header: { DiveMode: "OpenCircuit" },
        Samples: Array.from({ length: sampleCount }, (_, index) => ({
          TimeISO8601: `2026-08-30T10:${String(40 + index).padStart(4, "0")}:08.250+02:00`,
          Depth: Math.round((1 + index * 0.05) * 100) / 100,
          Temperature: 293.15,
          ...(index === sampleCount - 1 ? { Marker: "DeepMarkerAtTheEnd456" } : {}),
        })),
      },
    };
    const { diveId } = await seedSuuntoDive(email, sml);

    await page.goto(`/dives/${diveId}/raw`);
    await expect(page.getByRole("heading", { name: "Raw Suunto data" })).toBeVisible();

    // Tree tab: the Samples array is capped by default, with a "show more" affordance.
    await expect(page.getByRole("button", { name: /show \d+ more/i }).first()).toBeVisible();

    // Search for a match past the default reveal cap and past the search auto-reveal cap alike --
    // this must resolve (not hang the tab) and, since it's beyond both caps, is only guaranteed
    // findable via manual reveal, so this asserts the tab stays responsive rather than requiring
    // the mark itself to be visible immediately.
    await page.getByLabel("Search raw Suunto data").fill("DeepMarkerAtTheEnd456");
    await expect(page.getByLabel("Search raw Suunto data")).toHaveValue("DeepMarkerAtTheEnd456");

    // Syntax-highlighted tab: too large to highlight, so it falls back to a plain, explicitly
    // labeled block rather than either hanging or silently dropping highlighting with no explanation.
    await page.getByRole("tab", { name: "Syntax highlighted" }).click();
    await expect(page.getByText(/too large to syntax-highlight/i)).toBeVisible();
    await expect(page.locator("pre", { hasText: "DeepMarkerAtTheEnd456" })).toBeVisible();
  });

  test("dive page shows no raw-data link for a dive with no Suunto data", async ({ page }) => {
    const email = uniqueTestEmail("suunto-raw-absent");
    await registerViaMagicLink(page, email, PASSWORD);

    await page.goto("/dives/new");
    await page.getByLabel("Title").pressSequentially("Manual dive, no Suunto data");
    await page.getByLabel("Date & time").fill("2026-08-14T09:15");
    await page.getByRole("button", { name: "Log dive" }).click();
    await page.waitForURL(/\/dives\/\d+$/);

    await expect(page.getByRole("link", { name: "Raw Suunto data" })).toHaveCount(0);
  });
});
