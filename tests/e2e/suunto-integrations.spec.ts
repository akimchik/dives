import { expect, test } from "@playwright/test";

import { registerViaMagicLink } from "./helpers/auth";
import { seedSuuntoIntegration, uniqueTestEmail } from "./helpers/db";

const PASSWORD = "a-long-enough-password-123";

test("integrations page explains Suunto duplicate/reimport behavior", async ({ page }) => {
  await registerViaMagicLink(page, uniqueTestEmail("suunto-ui"), PASSWORD);

  await page.goto("/settings/integrations");
  await expect(page.getByRole("heading", { name: "Integrations" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Suunto" })).toBeVisible();
  await expect(page.getByLabel("Suunto email")).toBeVisible();
  await expect(page.getByLabel("Suunto password")).toBeVisible();
  await expect(page.getByText(/ignores workouts already staged or saved/i)).toBeVisible();
  await expect(page.getByText(/delete the staged import or saved dive first/i)).toBeVisible();
});

// Issue #24: the fetch dialog offers an unbounded "All time" mode alongside the recent-days window.
test("fetch dialog offers an All time mode that replaces the recent-days input", async ({ page }) => {
  const email = uniqueTestEmail("suunto-all");
  await registerViaMagicLink(page, email, PASSWORD);
  await seedSuuntoIntegration(email);

  await page.goto("/settings/integrations");
  await page.getByRole("button", { name: "Fetch Suunto workouts" }).click();
  await expect(page.getByRole("heading", { name: "Fetch Suunto workouts" })).toBeVisible();
  await expect(page.getByLabel("Recent days to check")).toBeVisible();

  await page.getByRole("radio", { name: "All time" }).click();
  await expect(page.getByLabel("Recent days to check")).toHaveCount(0);
  await expect(page.getByText(/every dive workout in your Suunto history/i)).toBeVisible();

  // The seeded session is deliberately undecryptable and no suuntool sidecar runs here, so the
  // action fails before it ever branches on the mode: this only proves the toggle and form reach
  // fetchSuuntoWorkoutsAction and surface its toast rather than hanging or throwing. Mode-specific
  // dispatch ("all" vs "days") is covered by tests/integration/suunto-actions.test.ts.
  const submit = page.getByRole("button", { name: "Fetch workouts" });
  await submit.click();
  await expect(page.getByText(/temporarily unavailable/i)).toBeVisible();
});
