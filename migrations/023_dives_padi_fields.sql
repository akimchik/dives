-- Additive-only, all nullable. These 8 columns are written exactly once, by
-- createDiveFromPadi's own insert -- never by DiveInput/diveValues()/updateDive --
-- so an ordinary manual edit can never null them out and silently break the
-- (user_id, padi_dive_id) dedup key.
alter table dives
  add column if not exists padi_dive_id integer;
alter table dives
  add column if not exists dive_number integer;
alter table dives
  add column if not exists padi_member_number integer;
alter table dives
  add column if not exists adventure_dive boolean;
alter table dives
  add column if not exists dive_type text;
alter table dives
  add column if not exists log_type text;
alter table dives
  add column if not exists log_course text;
alter table dives
  add column if not exists padi_status text;

create unique index if not exists dives_user_id_padi_dive_id_idx
  on dives (user_id, padi_dive_id) where padi_dive_id is not null;
