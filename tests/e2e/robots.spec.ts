import { expect, test } from "@playwright/test";

// Regression coverage for issue #105: SEO must stay off for the dev stage
// (dives.aleksandr.vin) but on everywhere else. The e2e webServer doesn't set
// OTEL_DEPLOYMENT_ENVIRONMENT, so this only exercises the non-dev-stage
// branch; app/robots.ts and lib/deployment-stage.ts unit tests cover the
// dev-stage branch directly.
test.describe("SEO robots behavior", () => {
  test("/robots.txt allows crawling outside the dev stage", async ({ request }) => {
    const response = await request.get("/robots.txt");

    expect(response.ok()).toBe(true);
    expect(await response.text()).toContain("Allow: /");
    expect(response.headers()["x-robots-tag"]).toBeUndefined();
  });

  test("pages don't carry an X-Robots-Tag header outside the dev stage", async ({ request }) => {
    const response = await request.get("/");

    expect(response.headers()["x-robots-tag"]).toBeUndefined();
  });
});
