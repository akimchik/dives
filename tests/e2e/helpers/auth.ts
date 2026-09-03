import type { Page } from "@playwright/test";

import { seedMagicLinkToken } from "./db";

/**
 * Registers a brand-new account end-to-end via a seeded magic-link token (see db.ts for
 * why the token must be seeded rather than captured from a real email), landing the
 * session on `/dashboard`. Returns once redirected.
 */
export async function registerViaMagicLink(page: Page, email: string, password: string) {
  const token = await seedMagicLinkToken(email);
  await page.goto(`/register/${token}`);
  await page.getByLabel(/password/i).pressSequentially(password);
  const submitButton = page.getByRole("button", {
    name: /(set password|create account|continue|sign up)/i,
  });
  await submitButton.click();
  await page.waitForURL(/\/dashboard\/?$/);
}
