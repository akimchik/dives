import { expect, test } from "@playwright/test";

// Regression test for plan Step 0: requireUser() used to redirect unauthenticated users to
// the (now-removed) /login route. It must now redirect to `/` with `next` preserved so the
// user returns to where they started after logging in.
test.describe("requireUser redirect regression", () => {
  test("visiting /dashboard while logged out redirects to / (not a dead /login link)", async ({
    page,
    context,
  }) => {
    await context.clearCookies();

    await page.goto("/dashboard");

    await expect(page).toHaveURL(/^http:\/\/localhost:3000\/(\?.*)?$/);
    expect(page.url()).not.toContain("/login");
  });

  test("preserves a next param pointing back at the originally-requested page", async ({
    page,
    context,
  }) => {
    await context.clearCookies();

    await page.goto("/dives/1");

    await expect(page).toHaveURL(/^http:\/\/localhost:3000\/\?next=/);
    expect(page.url()).not.toContain("/login");
    expect(decodeURIComponent(page.url())).toContain("/dives/1");
  });

  test("/login no longer exists as a real page and redirects to / instead", async ({
    page,
    context,
  }) => {
    await context.clearCookies();

    await page.goto("/login");

    await expect(page).toHaveURL(/^http:\/\/localhost:3000\/(\?.*)?$/);
  });
});
