# Local development

## Install

```sh
pnpm install
```

Node `>=24.0.0 <25` is required (pinned in `package.json` `engines`).

## Database

Postgres is the only backend (`lib/db.ts` / `lib/database-url.ts`, raw `pg`
driver against `DATABASE_URL`). Start a local Postgres and run the migrations
before `pnpm dev`:

```sh
docker-compose up -d postgres
pnpm db:migrate
```

(Use the standalone `docker-compose` binary; the `docker compose` v2 plugin
may not be installed on every machine.)

`pnpm db:migrate` runs `scripts/db-migrate.mjs` against the SQL files in
`migrations/`. It also bootstraps an admin user when these variables are set:

```sh
DIVES_ADMIN_EMAIL=admin@aleksandr.vin
DIVES_ADMIN_PASSWORD=change-me
```

### Migration numbering

This repo was scaffolded from the upstream 21daylabs Next.js template and
kept only that template's auth/session/notification migrations, under their original
filenames so the numbers still line up with the template they came from:

| File | Purpose |
| --- | --- |
| `001_users.sql` | `users` |
| `003_user_sessions.sql` | `user_sessions` |
| `004_magic_link_tokens.sql` | `magic_link_tokens` (password/magic-link login, off by default) |
| `014_notification_queue.sql` | `notification_queue` outbox |
| `016_oidc_users.sql` | Authentik columns on `users` (`oidc_subject`, `is_admin`) |
| `017_session_id_token.sql` | `user_sessions.id_token`, for RP-initiated logout |

The gaps (002, 005–013, 015, 018–022) are the template's BOM/nexar/catfooder
and `tos_acceptance` migrations, deliberately never ported. Nothing is missing;
do not try to "fill in" those numbers. New Dives migrations continue from the
highest number present.

`scripts/db-migrate.mjs`'s `grantAppRoleOperationalAccess` runs after every
migration batch and grants the low-privilege runtime role (`APP_DB_ROLE`)
ordinary CRUD on every table, plus `ALTER DEFAULT PRIVILEGES` so future
migrations' tables inherit the same grant automatically. **No per-table grant
migration is ever needed for a new table.**

## Run the app

```sh
pnpm dev
```

Visit `http://localhost:3000` (requires a migrated Postgres, see above).

`docker-compose up -d` also starts `pgadmin` (Postgres admin UI). There is no
object storage: dive media is an explicit non-goal for v1.

## Auth

Authentik (OIDC) is the only sign-in path. `lib/auth/oidc.ts` handles
discovery/PKCE, `app/api/auth/authentik/{route,signup,callback}` are the
sign-in, enrollment and callback Route Handlers, and `lib/session.ts` issues
and reads the session cookie.

`requireUser()` redirects unauthenticated visitors to `/`. It deliberately has
**no** ToS-acceptance gate — unlike the upstream template it was copied from,
this app has no `tos_acceptance` table, and re-adding `hasAcceptedTosVersion`
would 500 every authenticated page.

The local email/password + magic-link flow (`app/actions/auth.ts`,
`lib/magic-link.ts`, `lib/passwords.ts`, `app/register/[token]/`) stays in the
codebase but every entry point checks `isPasswordAuthEnabled()`
(`lib/auth-config.ts`) server-side. It is off unless `PASSWORD_AUTH_ENABLED=true`;
the Playwright e2e suite turns it on for itself (see `playwright.config.ts`).

The Authentik callback enqueues a `new_user_signup` notification on a first
sign-in (`lib/user-signup-notification.ts`), which is why `new_user_signup`
must stay in `notification_queue`'s `notification_type` check constraint.

## Email

`lib/mailer.ts` wraps `nodemailer` behind an `isMailerConfigured()` gate; when
the `email_*` env vars (see `.env.example`) are unset, sending is a graceful
no-op. `scripts/mailer.mjs` is its plain-JS twin for the CronJob worker, which
runs outside the Next build and can't import `@/lib` modules. Both send as
`Dives <email_host_user>` (currently `zulu@aleksandr.vin`).

## Notification queue + worker

`migrations/014_notification_queue.sql` defines `notification_queue` (status
`pending`/`sending`/`sent`/`failed`, `attempts`, `next_attempt_at`,
`locked_at`, jsonb `payload`, unique `idempotency_key`).
`scripts/notification-worker.mjs` is a CronJob (`notifications.schedule`,
default `*/2 * * * *`) running `processNotificationQueue` from
`scripts/notifications/queue.mjs`:

- **Reap** rows stuck in `sending` past `staleLockMs` (worker crash recovery),
  then **claim** a batch atomically with `FOR UPDATE SKIP LOCKED` (race-safe
  even without a `Forbid` concurrency policy).
- **Render + send** via `scripts/notifications/templates.mjs` and
  `scripts/mailer.mjs`, then mark the rows `sent`. On a retryable SMTP failure
  (Proton 4xx or a network/timeout error, per `classifySmtpError`) the row is
  rescheduled with exponential backoff and ±20% jitter (`computeBackoff`); on a
  permanent 5xx, or once `attempts` reaches `max_attempts`, it dead-letters to
  `failed`.
- `lib/notification-queue.ts` (TS, for the Next app) and
  `scripts/notifications/queue.mjs` (plain JS, for the worker) each carry their
  own `enqueueNotification` — the same TS/`.mjs` duplication `lib/mailer.ts`
  and `scripts/mailer.mjs` use.

## Tests

```sh
pnpm test        # typecheck + fast, DB-free unit tests (vitest)
pnpm test:pg     # Postgres-backed integration tests (vitest)
pnpm test:e2e    # Playwright end-to-end tests
```

`pnpm test:unit` (part of `pnpm test`) covers `tests/unit/**` only — pure
logic with no database access. `pnpm test:pg` runs `tests/integration/**`
against a real Postgres and requires `DATABASE_URL` (or `TEST_DATABASE_URL`)
pointing at a migrated database; it fails loudly if neither is set:

```sh
DATABASE_URL=postgres://dives_user:dives@localhost:5432/dev_dives \
  PASSWORD_AUTH_ENABLED=true pnpm test:pg
```

`PASSWORD_AUTH_ENABLED=true` is required for the magic-link/registration
integration tests specifically: they drive `completeRegistrationAction`, which
refuses to run at all while password auth is off (its normal deployed state).

Playwright is configured to use WebKit (see `AGENTS.md`), starts the Next.js
dev server automatically, and drives it against the same local Postgres.

## Healthcheck route

`app/api/health/route.ts` responds to health probes (used by the Helm
deployment's liveness/readiness checks) and also pings an external monitor
via `lib/healthcheck-ping.ts` when `HEALTHCHECK_PING_URL` is set. Leave it
unset locally — the ping is a no-op without it.

## OpenTelemetry

`instrumentation.ts` + `lib/otel.ts` wire up the OTel Node SDK (traces,
metrics, logs) on server start; `lib/logger.ts` provides a `pino` logger. No
collector is required for local dev — the exporters are only installed when
`OTEL_EXPORTER_OTLP_ENDPOINT` (or `..._TRACES_ENDPOINT`) is set.

`lib/auth-otel.ts` emits `auth.signups`/`auth.signins`/`auth.logouts`, labeled
`method` (`password` or `oidc`); `lib/email-otel.ts` emits `email.sends` and
`email.duration`. The notification CronJob bootstraps the same SDK via
`scripts/notifications/otel.mjs` and logs NDJSON via
`scripts/ndjson-console.mjs`.

## Deployment

`build-and-push.sh` builds the image and `helm upgrade --install`s
`helm-charts/` with `dev-values.yaml` (git-ignored; keep
`dev-values.example.yaml` in sync key-for-key). The chart runs migrations in an
initContainer as the schema owner (`database`) and everything else — the web
container and the notification-worker CronJob — as the low-privilege
`databaseApp` role.

`app/robots.ts` and `proxy.ts` lock the dev stage out of search engines, keyed
off `OTEL_DEPLOYMENT_ENVIRONMENT=dev` (`lib/deployment-stage.ts`). Both stay
request-time rather than statically baked, since one image is built and
deployed to every stage.
