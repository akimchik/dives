-- Free-text tags a user attaches to their own dives (issue #19). "missing-padi"/"missing-suunto"
-- are NOT stored here -- they're computed on read from padi_dive_id/suunto_workout_key plus the
-- user's integration connection status, so they never go stale when a dive is later synced or an
-- integration is connected/disconnected.
alter table dives
  add column if not exists tags text[] not null default '{}';

create index if not exists dives_tags_gin_idx
  on dives using gin (tags);
