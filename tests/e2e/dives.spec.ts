import { expect, test, type Page } from "@playwright/test";

import { registerViaMagicLink } from "./helpers/auth";
import { uniqueTestEmail } from "./helpers/db";

// End-to-end coverage for plan Step 6's UI screens. Two things are proven here:
//
// 1. Logged-out requests to the logbook routes are REDIRECTED (302/307), not served -- asserted on
//    the raw HTTP response rather than only on the landing URL, so a page that rendered dive data
//    with a 200 and then client-navigated away could not pass.
// 2. The whole lifecycle -- create -> list -> detail -> dashboard stats -> edit -> delete -- works
//    against a real Postgres. The delete step is explicitly part of this flow, not a separate
//    optional spec.
//
// Each test registers its own fresh user via a seeded magic-link token (helpers/auth.ts), so the
// dashboard's stats start from zero and can be asserted on exactly.

const PASSWORD = "a-long-enough-password-123";

const PROFILE_CSV = ["0:00, 0", "3:00, 12.4", "10:00, 27.4", "35:00, 9.0", "48:00, 0"].join("\n");

/**
 * Playwright's fill() dispatches a single input event that can race client hydration and get
 * dropped, leaving this form's controlled state empty (see helpers/auth.ts). So the first field is
 * typed key by key, and hydration is then *proven* by waiting for a button whose enabled state is
 * derived from React state -- "Create dive site" is disabled in the server-rendered HTML and can
 * only become enabled once the typed name has actually landed in state. Every later fill() is safe.
 */
async function fillSiteAndAwaitHydration(page: Page, siteName: string) {
  const siteInput = page.getByLabel("Dive site");
  await siteInput.pressSequentially(siteName);

  const createSite = page.getByRole("button", { name: "Create dive site" });
  await expect(createSite).toBeEnabled();

  // Exercises the inline-create path (createDiveSiteAction) rather than letting the dive's own
  // transaction create the site implicitly.
  await createSite.click();
  await expect(page.getByText(/using saved site/i)).toBeVisible();
}

/** Radix Select: click the trigger (labelled by aria-label), then pick the option by name. */
async function chooseOption(page: Page, label: string, option: string) {
  await page.getByLabel(label, { exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
  await expect(page.getByLabel(label, { exact: true })).toContainText(option);
}

test.describe("dive logbook", () => {
  test.describe("unauthenticated access", () => {
    // The plan's acceptance criterion is specifically that these return a redirect rather than
    // rendering any dive data, so assert on the status code, not just where the browser ended up.
    for (const path of ["/dives", "/dashboard"]) {
      test(`${path} redirects a logged-out visitor instead of rendering dive data`, async ({
        page,
        context,
      }) => {
        await context.clearCookies();

        const response = await page.request.get(path, { maxRedirects: 0 });

        expect([302, 307]).toContain(response.status());
        expect(response.headers()["location"]).toMatch(/^\/(\?next=)?/);
        // Assert on markup that only the *rendered* logbook emits. Matching on visible words
        // instead would be a false pass/fail either way: Next's dev redirect shell echoes the
        // route's <title> ("Logbook · Dives"), so the word "logbook" appears even though no dive
        // data does.
        const body = await response.text();
        expect(body).not.toContain('data-testid="dive-list"');
        expect(body).not.toContain('data-testid="stat-total-dives"');

        // And following it for real lands on the sign-in page, never on the requested route.
        await page.goto(path);
        await expect(page).toHaveURL(/^http:\/\/localhost:3000\/(\?.*)?$/);
        await expect(page.getByRole("heading", { name: "Dives" })).toBeVisible();
      });
    }
  });

  test("create -> list -> detail -> dashboard -> edit -> delete", async ({ page }) => {
    await registerViaMagicLink(page, uniqueTestEmail("dive-flow"), PASSWORD);

    // A fresh user starts with an empty logbook and zeroed stats.
    await expect(page.getByTestId("stat-total-dives")).toHaveText("0");

    // ---------------------------------------------------------------- create
    const siteName = `Blue Hole ${Date.now()}`;

    await page.goto("/dives/new");
    await fillSiteAndAwaitHydration(page, siteName);

    await page.getByLabel("Date & time").fill("2026-08-14T09:15");
    await page.getByLabel("Max depth (m)").fill("27.4");
    await page.getByLabel("Average depth (m)").fill("14.8");
    await page.getByLabel("Bottom time (min)").fill("48");
    await page.getByLabel("Water temp (°C)").fill("24.5");
    await page.getByLabel("Visibility (m)").fill("18");
    await chooseOption(page, "Entry type", "Boat");

    await page.getByLabel("Gas mix").fill("EAN32");
    await page.getByLabel("Cylinder").fill("12L steel, 200 bar");
    await page.getByLabel("Weight (kg)").fill("6");
    await chooseOption(page, "Suit", "Wetsuit 5mm");

    await chooseOption(page, "Current", "Mild");
    await chooseOption(page, "Surge", "None");
    await page.getByLabel("Weather").fill("Sunny, light chop");
    await page.getByLabel("Buddy / dive guide").fill("Sam Okafor");
    await page.getByLabel("Dive shop / operator").fill("Blue Hole Divers");
    await page.getByRole("radio", { name: "4 stars" }).click();

    await page.getByLabel("Notes").fill("Thermocline at 18m, turtles on the shallow shelf.");
    await page.getByLabel("Depth profile", { exact: true }).fill(PROFILE_CSV);

    // The profile must parse before submit is allowed at all.
    await expect(page.getByText("Parsed 5 points.")).toBeVisible();
    await expect(page.getByTestId("depth-profile-chart")).toBeVisible();

    await page.getByRole("button", { name: "Log dive" }).click();

    // ---------------------------------------------------------------- detail
    await page.waitForURL(/\/dives\/\d+$/);
    const diveUrl = page.url();

    await expect(page.getByRole("heading", { name: siteName })).toBeVisible();
    await expect(page.getByText("14 Aug 2026")).toBeVisible();

    // Every field submitted above is read back from the created row.
    const detail = page.getByRole("definition");
    await expect(detail.filter({ hasText: /^27\.4 m$/ })).toBeVisible();
    await expect(detail.filter({ hasText: /^14\.8 m$/ })).toBeVisible();
    await expect(detail.filter({ hasText: /^48m$/ })).toBeVisible();
    await expect(detail.filter({ hasText: /^24\.5 °C$/ })).toBeVisible();
    await expect(detail.filter({ hasText: /^18 m$/ })).toBeVisible();
    await expect(detail.filter({ hasText: /^Boat$/ })).toBeVisible();
    await expect(detail.filter({ hasText: /^EAN32$/ })).toBeVisible();
    await expect(detail.filter({ hasText: /^12L steel, 200 bar$/ })).toBeVisible();
    await expect(detail.filter({ hasText: /^6 kg$/ })).toBeVisible();
    await expect(detail.filter({ hasText: /^Wetsuit 5mm$/ })).toBeVisible();
    await expect(detail.filter({ hasText: /^Mild$/ })).toBeVisible();
    await expect(detail.filter({ hasText: /^None$/ })).toBeVisible();
    await expect(detail.filter({ hasText: /^Sunny, light chop$/ })).toBeVisible();
    await expect(detail.filter({ hasText: /^Sam Okafor$/ })).toBeVisible();
    await expect(detail.filter({ hasText: /^Blue Hole Divers$/ })).toBeVisible();
    await expect(page.getByText("Thermocline at 18m")).toBeVisible();
    await expect(page.getByLabel("Rated 4 out of 5")).toBeVisible();
    await expect(page.getByTestId("depth-profile-chart")).toBeVisible();

    // ------------------------------------------------------------------ list
    await page.goto("/dives");
    const listRow = page.getByTestId("dive-list").getByRole("listitem").first();
    await expect(listRow).toContainText(siteName);
    await expect(listRow).toContainText("27.4m");
    await expect(listRow).toContainText("48m");

    // ------------------------------------------------------------- dashboard
    await page.goto("/dashboard");
    await expect(page.getByTestId("stat-total-dives")).toHaveText("1");
    await expect(page.getByTestId("stat-total-bottom-time")).toHaveText("48m");
    await expect(page.getByTestId("stat-deepest-dive")).toHaveText("27.4");
    await expect(page.getByTestId("stat-distinct-sites")).toHaveText("1");

    // ------------------------------------------------------------------ edit
    await page.goto(`${diveUrl}/edit`);
    // The edit form must arrive pre-populated from the stored row.
    await expect(page.getByLabel("Max depth (m)")).toHaveValue("27.4");
    await expect(page.getByLabel("Buddy / dive guide")).toHaveValue("Sam Okafor");
    await expect(page.getByLabel("Depth profile", { exact: true })).toHaveValue(PROFILE_CSV);

    // First interaction on this freshly-loaded page -- same hydration race as
    // fillSiteAndAwaitHydration above (a single fill() event can be dropped if it lands before
    // React attaches its onChange listener, and unlike the /new form's create-site button there's
    // no JS-derived state here to prove hydration first). pressSequentially spans real keystrokes
    // over time instead of one atomic event, so it can't be silently lost the same way. Every field
    // after this one is safe, per the same reasoning as fillSiteAndAwaitHydration.
    const maxDepthInput = page.getByLabel("Max depth (m)");
    await maxDepthInput.click({ clickCount: 3 });
    await maxDepthInput.pressSequentially("31.2");
    await expect(maxDepthInput).toHaveValue("31.2");

    await page.getByLabel("Bottom time (min)").fill("52");
    await page.getByRole("button", { name: "Save changes" }).click();

    await page.waitForURL(/\/dives\/\d+$/);
    await expect(page.getByRole("definition").filter({ hasText: /^31\.2 m$/ })).toBeVisible();
    await expect(page.getByRole("definition").filter({ hasText: /^52m$/ })).toBeVisible();

    // Stats follow the edit.
    await page.goto("/dashboard");
    await expect(page.getByTestId("stat-deepest-dive")).toHaveText("31.2");
    await expect(page.getByTestId("stat-total-bottom-time")).toHaveText("52m");

    // ---------------------------------------------------------------- delete
    await page.goto(diveUrl);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("button", { name: "Delete dive" }).click();

    await page.waitForURL(/\/dives\/?$/);
    await expect(page.getByText(/your logbook is empty/i)).toBeVisible();

    // Gone from the stats too, and the detail route no longer resolves.
    await page.goto("/dashboard");
    await expect(page.getByTestId("stat-total-dives")).toHaveText("0");

    const deletedResponse = await page.request.get(diveUrl, { maxRedirects: 0 });
    expect(deletedResponse.status()).toBe(404);
  });

  test("a malformed depth profile blocks submit with the parser's own error", async ({ page }) => {
    await registerViaMagicLink(page, uniqueTestEmail("dive-bad-profile"), PASSWORD);

    await page.goto("/dives/new");
    await fillSiteAndAwaitHydration(page, `Bad Profile ${Date.now()}`);

    await page.getByLabel("Depth profile", { exact: true }).fill("0:00, 0\n3:00, 12.4\nnot-a-depth-row");

    // The parser's own message names the offending line -- a generic "invalid" string would not.
    await expect(page.getByTestId("depth-profile-error")).toContainText("Line 3");
    await expect(page.getByRole("button", { name: "Log dive" })).toBeDisabled();

    // Fixing the input re-enables submit; nothing was partially written in the meantime.
    await page.getByLabel("Depth profile", { exact: true }).fill(PROFILE_CSV);
    await expect(page.getByText("Parsed 5 points.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Log dive" })).toBeEnabled();
  });
});
