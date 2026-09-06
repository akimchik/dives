-- Suunto staged-import integration. The app owns all persistence and every row is user-scoped;
-- the suuntool sidecar remains stateless and only receives transient credentials/session files.
create table if not exists suunto_integrations (
  user_id integer primary key references users (id) on delete cascade,
  email_hash text not null,
  session_encrypted text not null,
  status text not null default 'connected' check (status in ('connected', 'needs_reconnect')),
  connected_at timestamptz not null default now(),
  last_fetch_at timestamptz,
  needs_reconnect_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists suunto_login_attempts (
  id serial primary key,
  user_id integer not null references users (id) on delete cascade,
  email_hash text not null,
  attempted_at timestamptz not null default now()
);

create index if not exists suunto_login_attempts_user_id_attempted_at_idx
  on suunto_login_attempts (user_id, attempted_at desc);

create index if not exists suunto_login_attempts_email_hash_attempted_at_idx
  on suunto_login_attempts (email_hash, attempted_at desc);

create table if not exists suunto_imports (
  id serial primary key,
  user_id integer not null references users (id) on delete cascade,
  workout_key text not null,
  workout_started_at timestamptz,
  summary jsonb not null default '{}'::jsonb,
  draft_dive jsonb not null default '{}'::jsonb,
  compiled_profile jsonb not null,
  original_bundle bytea not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, workout_key)
);

create index if not exists suunto_imports_user_id_created_at_idx
  on suunto_imports (user_id, created_at asc);

alter table dives
  add column if not exists suunto_workout_key text;

alter table dives
  add column if not exists suunto_profile jsonb;

alter table dives
  add column if not exists suunto_original_bundle bytea;

create unique index if not exists dives_user_id_suunto_workout_key_idx
  on dives (user_id, suunto_workout_key) where suunto_workout_key is not null;
