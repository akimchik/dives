import { expect, test } from "@playwright/test";

import { registerViaMagicLink } from "./helpers/auth";
import { seedDive, uniqueTestEmail } from "./helpers/db";

// Issue #23: average/percentile SAC-rate stats on the Dashboard, and a per-dive comparison against
// the previous 5 dives on the dive detail page. Issue #21: the Fetch PADI/Suunto buttons moved from
// Dashboard to the Logbook page.
//
// Six dives share the same cylinder (10L) / avg depth (10m, so 2 ATA) / bottom time (25min), only
// varying start/end pressure, so each dive's SAC rate is an exact, hand-computable round number:
// gasUsed = (start - end) * 10; SAC = gasUsed / 25 / 2 = gasUsed / 50.
const PASSWORD = "a-long-enough-password-123";

const DIVE_FIELDS = { avgDepth: 10, bottomTimeMinutes: 25, cylinderSize: 10 };

// Oldest to newest, SAC rates 10, 12, 14, 16, 18, 20 L/min.
const DIVES = [
  { occurredAt: "2026-01-01T09:00:00Z", startPressure: 200, endPressure: 150 }, // SAC 10
  { occurredAt: "2026-01-02T09:00:00Z", startPressure: 200, endPressure: 140 }, // SAC 12
  { occurredAt: "2026-01-03T09:00:00Z", startPressure: 200, endPressure: 130 }, // SAC 14
  { occurredAt: "2026-01-04T09:00:00Z", startPressure: 200, endPressure: 120 }, // SAC 16
  { occurredAt: "2026-01-05T09:00:00Z", startPressure: 200, endPressure: 110 }, // SAC 18
  { occurredAt: "2026-01-06T09:00:00Z", startPressure: 200, endPressure: 100 }, // SAC 20 (newest)
];

test("dashboard SAC stats, dive-page SAC comparison, and Logbook-relocated fetch buttons", async ({
  page,
}) => {
  const email = uniqueTestEmail("sac-rate");
  await registerViaMagicLink(page, email, PASSWORD);

  const diveIds: number[] = [];
  for (const dive of DIVES) {
    const { diveId } = await seedDive(email, { ...DIVE_FIELDS, ...dive });
    diveIds.push(diveId);
  }
  const [oldestDiveId, , , , , newestDiveId] = diveIds;

  await page.goto("/dashboard");

  // Last 5 dives (SAC 20, 18, 16, 14, 12) average to 16.0; the Fetch buttons no longer live here.
  await expect(page.getByTestId("stat-avg-sac-rate")).toHaveText("16.0");
  // 90th percentile of all six (10..20 step 2), linear-interpolated, is 19.0.
  await expect(page.getByTestId("stat-sac-rate-90th-percentile")).toHaveText("19.0");
  await expect(page.getByRole("link", { name: "Connect PADI" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Connect Suunto" })).toHaveCount(0);

  await page.goto("/dives");

  // The buttons now live on the Logbook page instead (neither PADI nor Suunto is connected for
  // this fresh user, so they render as "Connect ..." links to /settings/integrations).
  await expect(page.getByRole("link", { name: "Connect PADI" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Connect Suunto" })).toBeVisible();

  // Newest dive (SAC 20): previous 5 dives average to (18+16+14+12+10)/5 = 14.0, so the delta is
  // (20-14)/14 = +42.9% -> rounds to +43%, shown in red since it's worse (more gas used).
  await page.goto(`/dives/${newestDiveId}`);
  await expect(page.getByText("20.0 L/min")).toBeVisible();
  const worseDelta = page.getByText("(+43% vs last 5)");
  await expect(worseDelta).toBeVisible();
  await expect(worseDelta).toHaveClass(/text-red-600/);

  // Oldest dive (SAC 10) has no earlier dives to compare against, so no delta renders at all.
  await page.goto(`/dives/${oldestDiveId}`);
  await expect(page.getByText("10.0 L/min")).toBeVisible();
  await expect(page.getByText(/vs last 5/)).toHaveCount(0);
});
