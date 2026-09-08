create table if not exists dive_bookmarks (
  id serial primary key,
  user_id integer not null references users (id) on delete cascade,
  dive_id integer not null references dives (id) on delete cascade,
  name text not null,
  selected_text text not null,
  created_at timestamptz not null default now()
);

-- Every read is scoped by the session's user_id; occurred-at-desc equivalent ordering for a
-- bookmark list is created_at desc, since bookmarks don't have their own occurred_at.
create index if not exists dive_bookmarks_user_id_created_at_idx on dive_bookmarks (user_id, created_at desc);
create index if not exists dive_bookmarks_dive_id_idx on dive_bookmarks (dive_id);
