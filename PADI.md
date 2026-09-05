# PADI logbook sync

A user connects their PADI dive-certification account, and a "Sync PADI" button on the Dashboard
imports their PADI logbook into this app's own `dives` table. The only write-back supported today
is **creating** a local dive in PADI from the dive detail page; updating an already-linked PADI dive
remains out of scope.

Initial sync was tracked as Gitea issue [#1](https://gitea.pumpking.aleksandr.vin/software-engineer-vinokurov/dives/issues/1),
scoped via `.omc/specs/deep-interview-padi-logbook-sync.md` and `.omc/plans/padi-logbook-sync.md`
(workspace-local, not committed). The create-only PADI write-back is tracked as Gitea issue
[#2](https://gitea.pumpking.aleksandr.vin/software-engineer-vinokurov/dives/issues/2).

## Auth flow

This is **not** an OAuth/PKCE redirect flow. PADI's own web logbook authenticates with a direct
server-to-server credential POST, and this app relays the user's PADI login/password the same way:

1. **Connect** (`app/actions/padi.ts`'s `connectPadiAction`, via `/settings/integrations`): the user
   enters their PADI login and password. The server POSTs them once to
   `https://api.global-prod.padi.com/auth/api/oauth/login` (`scripts/padi/client.mjs`'s `login`)
   alongside a public, non-secret `clientId` constant. PADI responds with an `idToken`, `accessToken`,
   and `refreshToken`. **The password is used for this one request and is never stored, logged, or
   returned in any error message** — `PadiApiError`'s message is always a generic, status-only
   description, never the original request body.
2. **Encrypt + store** (`lib/padi/integrations.ts`'s `savePadiIntegration`): the three tokens are
   encrypted (AES-256-GCM, `scripts/padi/crypto.mjs`) and stored in `padi_integrations`, one row per
   user (`user_id` primary key). Each token field is encrypted separately, bound via AAD to
   `` `${userId}:${field}` `` (`field` ∈ `access`/`refresh`/`id`) so the three ciphertexts on one row
   aren't swappable with each other or with another user's row.
3. **Refresh** (`scripts/padi-token-refresh.mjs`, a CronJob every 30 minutes): PADI's `accessToken`
   expires in ~1 hour. The cronjob selects every `padi_integrations` row due within the next 35
   minutes, decrypts the stored `refreshToken`/`idToken`, and POSTs them to
   `https://api.global-prod.padi.com/auth/api/oauth/refresh`. On success, the new token set is
   normalized (the observed nested `{ tokens: ... }` shape and a flat token-set shape are both
   accepted), re-encrypted, and stored. A 2xx JSON body that does not contain tokens is never allowed
   to crash the cronjob: explicit refresh-token rejection text is handled as a reconnect event, while
   unrelated malformed bodies are logged as transient refresh failures. **The Dashboard sync action
   never refreshes tokens itself** — that's the cronjob's exclusive responsibility, avoiding a
   refresh-token-rotation race between the two.
4. **Reconnect on failure**: if PADI rejects a refresh (the refresh token itself died), the row is
   marked `status = 'needs_reconnect'` and the user receives a "reconnect your PADI account" email
   (`padi_reconnect` notification type, added to the existing `notification_queue` alongside
   `dive_backup`). Each disconnect **event** gets its own idempotency key (derived from
   `needs_reconnect_at`, not `connected_at`), so a user who disconnects, reconnects, and disconnects
   again is notified every time, not just the first.
5. **Sync** (`app/actions/padi.ts`'s `syncPadiAction` → `lib/padi/sync.ts`'s `syncPadiLogbook`,
   triggered by the Dashboard's "Sync PADI" button): decrypts the stored `idToken`, decodes the
   PADI affiliate id from that same token's `custom:affiliate_id` claim, and walks PADI's paginated
   logbook GraphQL endpoint end to end, importing every not-yet-seen dive. The logbook API bearer
   token is intentionally the idToken, not the accessToken, because PADI validates the bearer token's
   own affiliate claim against the `affiliate-id` header.
6. **Create in PADI** (`app/actions/padi.ts`'s `createPadiDiveAction` →
   `lib/padi/create.ts`'s `createDiveInPadi`, triggered by the dive detail page's "Create in PADI"
   button): available only for connected users and local dives with no `padi_dive_id`. It decrypts
   the stored `idToken`, builds the captured `insert_logbook_logs` GraphQL payload, POSTs it to
   `https://logbook.global-prod.padi.com/api/Logbook`, and stores the returned PADI id plus raw
   PADI provenance fields on the local dive. The local row is still filtered by `user_id` when it is
   marked, so another user's dive id can never be linked.

**Rate limiting**: a failed connect attempt is rate-limited on two dimensions
(`lib/padi/rate-limit.ts`): the calling app user (5 failed attempts / rolling hour — the user-facing
gate) and a peppered HMAC hash of the submitted PADI username (20 / rolling hour — a much looser
backstop against hammering one PADI account from multiple app accounts, exempting a user who already
has that PADI account connected). This asymmetry is deliberate: an earlier symmetric design would
have let anyone lock out a victim's own connect attempts just by knowing their PADI email.

**Encryption key**: `PADI_TOKEN_ENCRYPTION_KEY` (see `.env.example`), read lazily on first PADI
connect/sync/refresh — an unconfigured checkout still boots and serves every non-PADI page/test
normally. `PADI_TOKEN_ENCRYPTION_KEY_PREVIOUS` is only ever set during an active key rotation
(decrypt falls back to it if the current key fails), and is not a normal deployment secret.

## Create-in-PADI field map

`lib/padi/create.ts` maps the app's existing `dives` columns into PADI's create mutation shape.
Dates are sent as `MM/DD/YYYY`, timestamps are ISO seconds with no milliseconds, and the local site
name becomes PADI's free-text `dive_location`. The create payload mirrors the observed browser
request in the gitignored `scratch` file: one `general` insert object with nested `depth_times`,
`conditions`, `equipment`, and `experiences` `data` objects.

Key enum translations are intentionally conservative and visible in tests:

| App value | PADI create value |
|---|---|
| `entry_type = Shore` / `Pier / jetty` | `dive_type = BeachShore` |
| `entry_type = Boat` / `Liveaboard` / `Drift` | `dive_type = Boat` |
| `suit_type = Wetsuit 7mm` | `suit_type = FullSuit_7mm` (same pattern for 3mm/5mm) |
| `weight_feedback = Perfect` | `weight_type = Good` |
| `waves/current/surge = None/Mild/Moderate/Strong` | PADI `No*`/`Some*`/`Medium*`/`Strong*` (waves use `SmallWaves` for Mild and `LargeWaves` for Strong) |
| `rating = 1/2-3/4/5` | `feeling = Poor/Average/Good/Amazing` |
| Visibility distance `<=5m` / `<=15m` / `>15m` | `visibility = Low` / `Average` / `High` (PADI rejects `Medium`) |
| `gas_mix = Air` | `gas_mixture = Air`, `oxygen = 21`, `nitrogen = 79`, `helium = 0` |
| `gas_mix = EAN32` | `gas_mixture = Nitrox`, `oxygen = 32`, `nitrogen = 68`, `helium = 0` |
| Free-form `tank_info` like `2x7L, Steel 232bar` | `cylinder_type = Steel`, `cylinder_size = 14`; PADI gets only its material enum plus numeric size, never the raw custom text |

Updating an existing PADI dive is intentionally not implemented. Once `padi_dive_id` is present the
detail page hides the create button rather than offering an update path. If PADI returns a
user-fixable enum validation error, the server action returns that message to the button toast so
the user can edit the local dive and retry instead of seeing a generic failure.

## Import field map

PADI's `logbook_logs` GraphQL detail query (see the repo's local, gitignored `scratch` file for the
captured request/response shapes) returns nested `depth_times`/`conditions`/`equipment`/
`experiences`/`skills` objects as **1-element arrays**, not plain objects
(`lib/padi/field-map.ts` unwraps each via `record.field?.[0] ?? {}`). `dive_date` arrives with no
timezone offset (e.g. `"2026-08-30T00:00:00"`) and is treated as UTC midnight.

### Mapped to existing `dives` columns

| PADI field | `dives` column |
|---|---|
| `dive_date` | `occurred_at` (parsed as UTC midnight) |
| `dive_title` | `title` |
| `depth_times.max_depth` | `max_depth` |
| `depth_times.bottom_time` | `bottom_time_minutes` |
| `conditions.air_temp` | `air_temp` |
| `conditions.surface_water_temp` | `water_temp` |
| `conditions.bottom_water_temp` | `water_temp_low` |
| `conditions.visibility_distance` | `visibility` |
| `conditions.water_type` | `water_type` |
| `conditions.body_of_water` | `body_of_water` |
| `conditions.weather` | `weather` |
| `conditions.wave_condition` | `waves` |
| `conditions.current` | `current` |
| `conditions.surge` | `surge` |
| `equipment.suit_type` | `suit_type` |
| `equipment.weight` | `weight` |
| `equipment.weight_type` | `weight_feedback` |
| `equipment.additional_equipment[]` | `hood` / `gloves` / `boots` (string-array membership, e.g. `"Hood"` → `hood: true`) |
| `equipment.cylinder_type` | `tank_info` |
| `equipment.cylinder_size` | `cylinder_size` |
| `equipment.gas_mixture` | `gas_mix` |
| `equipment.starting_pressure` | `start_pressure` |
| `equipment.ending_pressure` | `end_pressure` |
| `experiences.notes` | `notes` |
| `experiences.buddies` | `buddy` |
| `experiences.dive_center` | `dive_shop` |
| `experiences.feeling` | `rating` (ordinal, best-effort — see note below the table) |
| `dive_type` | `entry_type` (translated: `"BeachShore"` → `"Shore"`, `"Boat"` → `"Boat"`; an unrecognized future value passes through verbatim rather than being dropped, matching `body_of_water`'s existing free-text fallback) |
| `dive_location` | resolved to a `dive_sites` row via `createDiveFromPadi` → `resolveDiveSiteId` (`lib/dives.ts`), the exact same name-based create-or-reuse (`findOrCreateDiveSite`) the manual dive form already uses — a site the user already has (matched case-insensitively) is reused, not duplicated. No lat/lng: PADI's logbook export carries only a free-text location name. An empty/missing `dive_location` leaves `dive_site_id` null, same as a manual dive logged with no site picked |

`experiences.feeling` → `rating` is a **best-effort ordinal mapping, not a confirmed PADI spec**: only
4 distinct values have ever been observed across a real 75-dive export (`"Poor"`, `"Average"`,
`"Good"`, `"Amazing"` — no null-adjacent "Fair"/"Terrible" tier seen), so `lib/padi/field-map.ts`
maps them by what the words mean on a 1-5 star scale rather than packing them into consecutive
integers: `Poor`→1, `Average`→3 (the middle of the scale, matching its name), `Good`→4, `Amazing`→5.
Rating 2 is intentionally unreachable from PADI data — there's no observed PADI word that means
"between Poor and Average" to place there. An unrecognized future value (or no `feeling` at all)
maps to `null` (unrated), not a guessed number: unlike `entry_type`'s free-text column,
`dives.rating` has a `check (rating between 1 and 5)` constraint a wrong guess can't dodge via
passthrough.

### Mapped to new, PADI-only `dives` columns (migration `023_dives_padi_fields.sql`)

These 8 columns are written exactly once, by `createDiveFromPadi`'s own insert
(`lib/dives.ts`) — never by the ordinary `DiveInput`/`updateDive` edit path, so a manual edit of an
imported dive can never null them out and silently break the dedup key.

| PADI field | `dives` column | Notes |
|---|---|---|
| `id` | `padi_dive_id` | Dedup key: `unique (user_id, padi_dive_id) where padi_dive_id is not null` |
| `log_number` | `dive_number` | Renamed from PADI's `log_number`. Null in every sample record observed — PADI's web logbook doesn't appear to populate it in practice |
| `memsys_member_number` | `padi_member_number` | Renamed. `0` observed in the only sample record — see Open follow-ups below |
| `adventure_dive` | `adventure_dive` | PADI sends a string or `null`; stored as `Boolean(value)` |
| `dive_type` | `dive_type` | e.g. `"BeachShore"`. Also feeds `entry_type` (see the existing-columns table above) — stored twice: verbatim here as raw PADI provenance, translated there as the user-facing entry-type value |
| `log_type` | `log_type` | e.g. `"Recreational"` |
| `log_course` | `log_course` | Certification course name, if any |
| `status` | `padi_status` | Renamed from PADI's `status` to avoid colliding with `padi_integrations.status` / `notification_queue.status` — an intentional deviation, don't "fix" it back |

### Explicitly unmapped (no home, not silently dropped)

| PADI field | Why |
|---|---|
| `equipment.oxygen` / `nitrogen` / `helium` | No existing column; not added in v1 |
| `depth_times.time_in` / `time_out` | No existing column; not added in v1 |
| `conditions.visibility` (string enum, e.g. `"Low"`) | Distinct from the already-mapped numeric `visibility_distance` |
| `skills.dive_skills` | No existing column |

`lib/padi/field-map.ts` exports `MAPPED_FIELDS`/`UNMAPPED_FIELDS`, and its own test asserts every key
in a real sample record is in one set or the other — a future PADI field neither list knows about
fails that test instead of silently importing as `null`.

## Open follow-ups

- **`padi_member_number: 0`**: the only sample record observed has `memsys_member_number: 0`. Stored
  verbatim rather than guessed at — unclear whether `0` is a real value or PADI's absence sentinel.
- **`experiences.feeling` → `rating` ordinal mapping**: revisit if a 5th PADI feeling tier is ever
  observed (see the note under the field-map table above) — the mapping was chosen from only 4
  distinct values seen in one 75-dive export, not from PADI's own documentation.

## Non-goals (v1)

- No updating existing PADI dives.
- No automatic/scheduled sync — only user-triggered, via the Dashboard button.
- No incremental/date-filtered sync — each sync walks the full logbook; the insert-only dedup
  (`on conflict (user_id, padi_dive_id) do nothing`) makes repeat full syncs cheap and safely
  resumable if a sync's 45-second wall-time budget is hit mid-run.
