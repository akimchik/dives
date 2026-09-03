create table if not exists dive_sites (
  id serial primary key,
  user_id integer not null references users (id) on delete cascade,
  name text not null,
  location text,
  lat double precision,
  lng double precision,
  created_at timestamptz not null default now()
);

-- Every read is scoped by the session's user_id; the leading user_id column also
-- serves plain per-user lookups, and the trailing name supports site autocomplete.
create index if not exists dive_sites_user_id_name_idx on dive_sites (user_id, name);
