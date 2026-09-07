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
| `018_dive_sites.sql` | `dive_sites` (Dives) |
| `019_dives.sql` | `dives` (Dives) |

The gaps (002, 005–013, 015) are the template's BOM/nexar/catfooder migrations,
deliberately never ported, as are the template's own 018–022 (`tos_acceptance`
and its follow-up `notification_type` constraint alters). Nothing is missing; do
not try to "fill in" those numbers. New Dives migrations continue from the
highest number present — `018`/`019` above are Dives' own tables, not the
template's.

### `notification_queue.notification_type`

`014_notification_queue.sql` is the template's file with one hand-edit: its
`notification_type` check constraint lists exactly the types this app enqueues —
`new_user_signup` (the Authentik signup callback, `lib/user-signup-notification.ts`)
and `dive_backup` (every dive create/edit/delete). The template's BOM/ToS types
(`bom_uploaded`, `first_check`, `status_change`, `tos_acceptance`) are gone along
with the features that enqueued them, and the template's `019`/`021` follow-up
migrations — which only `alter` that constraint on an already-live table — were
not ported. Adding a new notification type means editing this constraint list;
there is no live deployment to `alter` yet.

### Dive tables

`dive_sites` and `dives` are both owned per user: `user_id integer not null
references users (id) on delete cascade`, with a leading-`user_id` index on each
so every query can be (and must be) filtered by the session's user. `dives.dive_site_id`
is nullable and `on delete set null` — deleting a site never deletes the dives
logged at it.

`scripts/db-migrate.mjs`'s `grantAppRoleOperationalAccess` runs after every
migration batch and grants the low-privilege runtime role (`APP_DB_ROLE`)
ordinary CRUD on every table, plus `ALTER DEFAULT PRIVILEGES` so future
migrations' tables inherit the same grant automatically. **No per-table grant
migration is ever needed for a new table.**

## Dive logbook data access

`lib/dives.ts` holds every dive/dive-site query. `app/actions/dives.ts` exposes the
`"use server"` wrappers the dive form calls (`createDiveAction`,
`updateDiveAction`, `deleteDiveAction`, plus `searchDiveSitesAction`/
`createDiveSiteAction` for the site autocomplete), while
`app/actions/dive-sites.ts` exposes the management-page wrappers
(`updateDiveSiteAction`, `mergeDiveSitesAction`). Every function there takes the
session user's id — resolved by `requireUser()` in the action, never from a URL
or form field — and filters on it. A dive or site id belonging to somebody else
matches no row: reads return `null`/an empty list, mutations throw
`DiveNotFoundError`/`DiveSiteNotFoundError`, so cross-user access is always
not-found and never a partial write.

Each dive mutation runs as one transaction (`getPool().connect()` → `begin` →
write → `commit`, released in a `finally`) that also resolves the dive site
(create-or-reuse by name, so a rolled-back dive leaves no orphan site) and
enqueues the `dive_backup` notification through
`enqueueNotification(..., { client })`. The dive row and its backup email can
therefore never exist without each other. Deletes snapshot the dive *before*
removing it, since the worker draining the queue later has no row left to read.
Dive-site merge is also transactional: it locks both owned site rows, applies the
chosen result properties to the survivor, rewrites `dives.dive_site_id` for the
source site to the survivor, then deletes the source site.

The enqueued payload is the flat
`{ event, dive: { ...columns, site_name, site_location, site_lat, site_lng } }`
contract the worker's renderer expects (see "Combinable vs per-row notification
types" below) — the site is flattened into `site_*` keys rather than nested,
because the CSV attachment writes one cell per key. Each enqueue mints its own
`dive-backup:<id>:<event>:<uuid>` idempotency key, so two consecutive edits of the
same dive produce two outbox rows instead of collapsing into one.

## Dive logbook screens

| Route | What it renders |
| --- | --- |
| `/dashboard` | `getDiveStats` tiles (total dives, total bottom time, deepest dive, distinct sites) + connected integration fetch buttons for PADI/Suunto + a GitHub-style activity calendar (`components/dive-activity-calendar.tsx`, backed by `getDiveActivityByDay`/`getEarliestDiveDate`) with a year-range selector (1..N years or All, N capped at 10) + the five most recent dives |
| `/dives` | The whole logbook, newest first |
| `/dive-sites` | All saved dive sites with attached-dive counts, edit buttons, and a two-site merge workflow (`components/dive-sites-manager.tsx`) that lets the user choose the surviving row plus which name/location/coordinates to keep |
| `/dives/[id]` | One dive in full, with its depth-profile chart, a create-in-PADI action for unlinked dives, and an update-to-PADI action for linked recreational dives marked out-of-sync |
| `/dives/new`, `/dives/[id]/edit` | The dive form (same `components/dive-form.tsx` in both modes) |

All authenticated logbook screens call `requireUser("<their own path>")` before any query, so a logged-out
request is redirected (307) to `/?next=…` and never reaches `lib/dives.ts`.
`/dives/[id]` and `/dives/[id]/edit` render `notFound()` both for ids that do not
exist and for ids owned by someone else — the two are deliberately
indistinguishable.

Shared pieces live in `components/`: `app-shell.tsx` (header + nav, wrapping
every authenticated screen), `manage-menu.tsx` (the header menu linking to Dive
Sites and Integrations), `dive-form.tsx`, `dive-site-field.tsx` (autocomplete
over the user's own sites, with inline create), `dive-sites-manager.tsx`,
`depth-profile-field.tsx`, `depth-profile-chart.tsx`, `create-padi-dive-button.tsx` and
`delete-dive-button.tsx`. Every button that makes a server call follows `AGENTS.md`'s convention:
disabled with a spinner for the duration, then a sonner toast on the result.

### Depth profile

`lib/depth-profile.ts` is framework-free and has no `server-only` import on
purpose, so the exact same parser runs in two places: the form parses the pasted
or uploaded text in the browser on every keystroke (so a malformed profile
disables submit and shows the parser's own line-specific error before any server
action is called, and `depth_profile` is never partially written), and the detail
page narrows the JSONB it read back with the same module's `isDepthProfile`
guard. The raw text is stored verbatim in `depth_profile_raw` alongside the
derived `depth_profile` JSON, so a future parser change can re-derive it.

`components/depth-profile-chart.tsx` and `components/suunto-profile-chart.tsx`
are client components built on shadcn's `chart.tsx` (recharts) — shadcn's Area
Chart - Gradient, with tooltips. The depth y-axis uses recharts' `reversed`, so
depth still grows downward and the trace reads like a dive computer's.
`SuuntoProfileChart`'s six streams
(depth/temperature/tankPressure/gasConsumption/gasConsumptionRate/surfaceConsumptionRate)
don't share a scale, so only the primary selected stream draws a (visible)
y-axis; a multi-select `ToggleGroup` lets several streams be overlaid at once,
with the tooltip reporting every selected stream's real value at the hovered
time. `gasConsumptionRate` is `lib/suunto/profile.ts`'s `rate(gas_used[1m])`
— the average bar/min drop in tank pressure over the trailing 1-minute window
ending at each point, computed with a two-pointer walk since points are
already time-ordered. `surfaceConsumptionRate` is that same rate normalized
to a Surface Air Consumption (SAC) rate in L/min via `lib/gas-consumption.ts`'s
shared `ataAtDepth` helper — raw bar/min reads faster at depth purely because
compressed gas is denser there, so it isn't comparable point-to-point without
this normalization; the whole stream is `null` when a dive's tank size wasn't
captured, since bar/min can't be converted to L/min without it. The component
takes just `points`, not the whole `SuuntoDiveProfile`, so the raw Suunto
summary blob (see below) never crosses the server→client boundary.

### Theme

`components/CausticOverlay.tsx` is a byte-for-byte copy of the component from
`2prutsers.com` and is mounted once in `app/layout.tsx`. It is the only
underwater motif in the app — deliberately. Nothing else changes Tailwind theme
colours or fonts, and no other component adds wave/bubble decoration. It is
`fixed`, `pointer-events-none` and sits at `z-index: 25`, above `AppShell`'s
`z-10` page content, so the light rays wash visibly over edit boxes, buttons
and cards instead of being hidden behind them. Being `pointer-events-none`
means this never intercepts a click. It stays below Radix portal content
(dialogs/dropdowns/selects/tooltips, all `z-50`), so popovers and menus still
render above the rays.

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
  and `scripts/mailer.mjs` use. The TS one takes an optional
  `{ client }` second argument so a caller can enqueue inside its own
  transaction (dive mutations write the dive row and its `dive_backup`
  notification atomically); without it, it uses a pooled connection.

### Combinable vs per-row notification types

`queue.mjs`'s `COMBINABLE_TYPES` decides how claimed rows are grouped into
emails:

- **Combinable** (`new_user_signup`): all of a recipient's rows are collapsed
  into one email by `renderCombinedEmail`, and marked `sent`/retried together.
- **Not combinable** (`dive_backup`, `padi_reconnect`): each row is its own
  email, claimed, sent and marked individually. A dive backup carries a JSON +
  CSV snapshot of the dive as attachments (built in the send path, passed
  through `sendMail`'s optional `attachments` argument to nodemailer), which a
  combined email has no way to represent. Its payload is
  `{ event: "create" | "edit" | "delete", dive: { ...flat column snapshot } }`.
  `padi_reconnect` (see [PADI.md](../PADI.md)) has no attachments; its payload
  is just `{ userId }`.

Both the email body and the CSV order columns through `templates.mjs`'s
`orderedDiveColumns` — known `dives` columns first in a fixed reading order,
unknown ones appended alphabetically. Postgres normalises jsonb key order on
write, so the payload's own key order coming back out of the queue is *not* the
order the server action wrote it in; ordering there instead keeps every backup's
columns identical. A row whose `notification_type` no renderer handles throws
rather than being silently marked sent with no email.

## PADI logbook sync

See [PADI.md](../PADI.md) for the full auth-flow explanation and field map.
In short: `app/actions/padi.ts`'s `connectPadiAction` relays a user's PADI
login/password to PADI's own login endpoint once (server-side, password never
stored), encrypts the returned tokens (`scripts/padi/crypto.mjs`,
`PADI_TOKEN_ENCRYPTION_KEY`), and a `padi-token-refresh` CronJob
(`padiTokenRefresh.schedule`, default `*/30 * * * *`) keeps the access token
fresh via `scripts/padi/token-refresh.mjs`; malformed 2xx refresh bodies are
classified instead of being allowed to crash the CronJob. A "Fetch PADI" button
(`syncPadiAction` → `lib/padi/sync.ts`) imports the user's full logbook into
`dives`, deduped by `padi_dive_id`, and compares already-linked details so
linked recreational dives whose local fields differ are flagged with
`padi_needs_update`. The detail page's "Update to PADI" action uses the captured
recreational update mutation and never updates PADI course/training dives.
Requires `PADI_TOKEN_ENCRYPTION_KEY` and `PADI_USERNAME_HASH_PEPPER` (see
`.env.example`); both are read lazily, so an unconfigured checkout still boots
and serves every non-PADI page/test normally.


## Suunto staged imports

Suunto integration is fetch-only and user-triggered. The fetch dialog asks for how many recent days to check and the sidecar lists workouts with `suuntool workouts list --since <days>d --limit 100 --format json`. The Next app talks only to a
pod-local, stateless suuntool sidecar (`scripts/suunto-sidecar/server.mjs`) over
`http://127.0.0.1:<port>`; there is no Service, Ingress, PVC, background sync, or
Suunto write-back path. The sidecar runs fixed `suuntool` commands, passes the
Suunto password to `suuntool login --password-stdin`, writes any supplied session
to a temporary `SUUNTOOL_SESSION_FILE`, and deletes that temp directory after the
request. It emits structured JSON logs for request lifecycle, suuntool exit codes, output sizes, list result shape/counts, and export bundle file names; password and session payloads are redacted before logging.

The app owns persistence. `suunto_integrations` stores only a hashed email and an
encrypted suuntool session JSON (`SUUNTO_SESSION_ENCRYPTION_KEY`, falling back to
`PADI_TOKEN_ENCRYPTION_KEY` for local compatibility); it never stores the user's
Suunto password. `suunto_imports` stores staged workout imports per user until the
user reviews them. Saved dives carry `suunto_workout_key` plus the compiled
`suunto_profile` JSON used by charts; the original exported bundle is retained in
`suunto_original_bundle` but is deliberately not selected into ordinary dive
snapshots/backups/UI DTOs.

Duplicate handling mirrors PADI sync semantics: a Suunto workout key already
saved to `dives` or already staged in `suunto_imports` is ignored. To re-import a
workout, the user must delete the saved/staged copy first. A reviewed staged item
is consumed in the same transaction that creates the dive, and the resulting dive
is a normal local dive eligible for PADI upload.

`lib/suunto/profile.ts` compiles `workout.sml.json` into a versioned JSON profile
with depth, temperature, tank pressure and gas-consumption points, while also
producing the simple `{ time, depth }[]` `depth_profile` used by the existing
chart/form code. Suunto SML exports can split `DiveHeader`, `DiveFooter`,
`Windows`, and `Header` across separate summary samples; the parser merges those
rows before extracting average depth, dive/bottom time, pressure endpoints and
location. Exported workout metadata does not include a human-readable site name,
and may carry zeroed top-level positions. Coordinates are drafted only from
workout-scoped SML sources: `DiveLocation.Stop`, `DiveLocation.Start`,
`DiveRouteOrigin`, or per-sample latitude/longitude. Lone `LastKnownCoordinates`
values are ignored because observed Suunto exports can carry a stale watch/app
location from another workout when the dive itself has no GPS route. Accepted
coordinates are converted from radians to degrees when needed and drafted as a
coordinate-named site (`Suunto GPS <lat>, <lng>`) for user review. Plain air is
normalized to `Air` rather than `Air 21% O₂`.

The Integrations page shows a `Review staged dives` link whenever pending Suunto
imports exist. The review queue is ordered by workout time; save, merge, delete,
and cancel continue to the next staged item when one exists, otherwise they
return to the normal destination.

The Suunto review form can either save the staged import as a new dive or merge it
into an existing user-owned dive. Merge candidates are existing dives without a
Suunto workout id, ordered by closeness to the staged workout date. The merge
flow is an explicit two-step dialog: first choose the target dive, then choose
field-by-field whether each editable value survives from the reviewed Suunto
import or from the existing dive, mirroring the dive-site merge workflow. Merging
attaches the Suunto workout id/profile/original bundle to the selected dive,
deletes the staged import, and enqueues a normal edit backup in one transaction.

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
