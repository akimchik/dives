import { defineConfig, devices } from "@playwright/test";

import { loadEnvFiles } from "./scripts/env.mjs";

// The Playwright test process (unlike `next dev`) doesn't load .env files on its own, but
// tests/e2e/helpers/db.ts connects to Postgres directly from that process, so it needs
// DATABASE_URL etc. populated here too.
loadEnvFiles();

export default defineConfig({
  testDir: "./tests/e2e",
  // CI (shared runners, a separate test-postgres service container over the
  // docker network instead of localhost) is measurably slower than local
  // docker-compose -- the heaviest test here (create -> edit -> delete, ~30
  // assertions + several real Postgres round trips) ran fine locally but hit
  // the flat 30s budget in Gitea Actions. Local dev keeps the tighter budget
  // so a genuinely hung test still fails fast.
  timeout: process.env.CI ? 60_000 : 30_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    video: "on",
  },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      // Postgres is mandatory. The dev server and the e2e helpers (tests/e2e/helpers/db.ts)
      // both talk to this same database so tests can seed state (e.g. magic-link tokens) the
      // UI can't trigger deterministically. e2e data is collision-safe via random emails, so
      // reusing the local dev database is fine — no separate e2e database is provisioned.
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "",
      // The app defaults to Authentik-only login (see lib/auth-config.ts); the email/password
      // + magic-link flow these e2e tests drive only renders/accepts requests when this is on.
      PASSWORD_AUTH_ENABLED: "true",
    },
  },
  projects: [
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
  ],
});
