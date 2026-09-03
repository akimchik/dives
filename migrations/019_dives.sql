create table if not exists dives (
  id serial primary key,
  user_id integer not null references users (id) on delete cascade,
  -- Optional: a dive can be logged before its site is named, and deleting a site
  -- must never delete the dives logged there.
  dive_site_id integer references dive_sites (id) on delete set null,
  occurred_at timestamptz not null,
  max_depth numeric(5, 2),
  avg_depth numeric(5, 2),
  bottom_time_minutes integer,
  water_temp numeric(4, 1),
  visibility numeric(5, 1),
  gas_mix text,
  tank_info text,
  weight numeric(5, 2),
  suit_type text,
  buddy text,
  dive_shop text,
  current text,
  surge text,
  weather text,
  entry_type text,
  notes text,
  rating smallint check (rating between 1 and 5),
  depth_profile jsonb,
  depth_profile_raw text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Every read is scoped by the session's user_id; occurred_at desc is the logbook's
-- default ordering.
create index if not exists dives_user_id_occurred_at_idx on dives (user_id, occurred_at desc);
create index if not exists dives_dive_site_id_idx on dives (dive_site_id);
