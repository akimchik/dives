create table if not exists user_sessions (
  id text primary key,
  user_id integer not null references users (id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists user_sessions_user_id_idx on user_sessions (user_id);
