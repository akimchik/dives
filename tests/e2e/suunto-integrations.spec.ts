import { expect, test } from "@playwright/test";

import { registerViaMagicLink } from "./helpers/auth";
import { uniqueTestEmail } from "./helpers/db";

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
