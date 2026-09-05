-- Tracks whether a linked recreational dive has local fields that should be pushed back to PADI.
-- This is an app-side action flag, not a mirror of PADI state: sync sets it after comparing the
-- fetched PADI detail with the local row, and manual edits set it for linked recreational dives.
alter table dives
  add column if not exists padi_needs_update boolean not null default false;

alter table dives
  add column if not exists padi_last_compared_at timestamptz;

create index if not exists dives_user_id_padi_needs_update_idx
  on dives (user_id, padi_needs_update) where padi_needs_update = true;
