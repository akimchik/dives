create table if not exists padi_login_attempts (
  id serial primary key,
  user_id integer not null references users (id) on delete cascade,
  username_hash text not null,
  attempted_at timestamptz not null default now()
);

-- Rows are inserted only on a failed PADI login. Two rate-limit dimensions are
-- checked against this table: user_id (the user-facing gate) and username_hash
-- (a looser backstop against hammering one PADI account from multiple app users).
create index if not exists padi_login_attempts_user_id_attempted_at_idx
  on padi_login_attempts (user_id, attempted_at desc);
create index if not exists padi_login_attempts_username_hash_attempted_at_idx
  on padi_login_attempts (username_hash, attempted_at desc);
