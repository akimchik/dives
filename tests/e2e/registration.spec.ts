import { expect, test } from "@playwright/test";

import { seedMagicLinkToken, uniqueTestEmail } from "./helpers/db";

// End-to-end coverage for plan Steps 4-6 (unified auth entry point + credential-creation
// page). Real email delivery is never exercised in dev/test (no SMTP configured), so the
// "click the emailed magic link" step is simulated by seeding a valid, unused token row
// directly into magic_link_tokens (see helpers/db.ts) rather than scraping server logs or
// an inbox — the raw token is never recoverable any other way, by design (plan Step 2:
// "never store or log the raw token"). Everything else (the email-entry UI, the
// credential-creation UI, the resulting session/redirect) is driven for real.
//
// Selectors below assume the plan's described UI: an email input + "Continue" button on
// `/`, a "check your email" confirmation state, and a password input + submit button on
// `/register/[token]`. If subtask 2's landed markup uses different copy, only the locators
// need adjusting — the assertions describe the required behavior.
const PASSWORD = "a-long-enough-password-123";

test.describe("registration and login", () => {
  test("full registration flow: email -> magic link -> set password -> /dashboard", async ({
    page,
  }) => {
    const email = uniqueTestEmail("register-flow");

    await page.goto("/");
    // pressSequentially, not fill: fill() dispatches a single native input event that can race
    // this page's client hydration and get dropped, leaving the controlled email/password state
    // (and thus the submit button's disabled condition) stuck -- see helpers/auth.ts's
    // registerViaMagicLink.
    await page.getByLabel(/email/i).pressSequentially(email);
    await page.getByRole("button", { name: /continue/i }).click();

    await expect(page.getByText(/check your email/i)).toBeVisible();

    // Simulate clicking the emailed magic link.
    const token = await seedMagicLinkToken(email);
    await page.goto(`/register/${token}`);

    await page.getByLabel(/password/i).pressSequentially(PASSWORD);
    await page.getByRole("button", { name: /(set password|create account|continue|sign up)/i }).click();

    await expect(page).toHaveURL(/\/dashboard\/?$/);
  });

  test("expired or already-used token shows an error instead of crashing", async ({ page }) => {
    const email = uniqueTestEmail("used-token");
    const token = await seedMagicLinkToken(email);

    // Consume it once for real via the UI.
    await page.goto(`/register/${token}`);
    await page.getByLabel(/password/i).pressSequentially(PASSWORD);
    await page.getByRole("button", { name: /(set password|create account|continue|sign up)/i }).click();
    await expect(page).toHaveURL(/\/dashboard\/?$/);

    // Second visit with the same (now-used) token must show a friendly error, not crash.
    // Token validity is only checked on submit (page render never inspects it, per plan
    // Step 6), so the error only appears after actually resubmitting the form.
    await page.context().clearCookies();
    await page.goto(`/register/${token}`);
    await page.getByLabel(/password/i).pressSequentially(PASSWORD);
    await page.getByRole("button", { name: /(set password|create account|continue|sign up)/i }).click();

    // The error renders both inline and as a toast (same text in both), so scope to the
    // first match rather than tripping Playwright's strict-mode multi-element check.
    await expect(page.getByText(/(expired|already used|invalid)/i).first()).toBeVisible();
  });

  test("existing user logs in via the inline password field and lands on /dashboard", async ({
    page,
  }) => {
    const email = uniqueTestEmail("existing-login");
    const token = await seedMagicLinkToken(email);

    await page.goto(`/register/${token}`);
    await page.getByLabel(/password/i).pressSequentially(PASSWORD);
    await page.getByRole("button", { name: /(set password|create account|continue|sign up)/i }).click();
    await expect(page).toHaveURL(/\/dashboard\/?$/);

    await page.context().clearCookies();
    await page.goto("/");
    await page.getByLabel(/email/i).pressSequentially(email);
    await page.getByRole("button", { name: /continue/i }).click();

    const passwordField = page.getByLabel(/password/i);
    await expect(passwordField).toBeVisible();
    await passwordField.fill(PASSWORD);
    await page.getByRole("button", { name: /(log in|sign in|continue)/i }).click();

    await expect(page).toHaveURL(/\/dashboard\/?$/);
  });
});
