create table if not exists magic_link_tokens (
  id serial primary key,
  email text not null,
  token_hash text unique not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists magic_link_tokens_token_hash_idx
  on magic_link_tokens (token_hash);
