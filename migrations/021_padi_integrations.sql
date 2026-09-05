create table if not exists padi_integrations (
  user_id integer primary key references users (id) on delete cascade,
  username_hash text not null,
  access_token_encrypted text not null,
  refresh_token_encrypted text not null,
  id_token_encrypted text,
  expires_at timestamptz not null,
  status text not null default 'connected' check (status in ('connected', 'needs_reconnect')),
  -- Set exactly when status flips to needs_reconnect, cleared on every successful
  -- (re)connect. The padi_reconnect notification's idempotency key derives from this,
  -- not connected_at, so each disconnect event is individually notifiable.
  needs_reconnect_at timestamptz,
  connected_at timestamptz not null default now(),
  synced_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Backs the username_hash rate-limit exemption: a user_id already connected on a
-- given PADI account is never blocked from reconnecting by someone else's failed
-- attempts against the same hash.
create index if not exists padi_integrations_username_hash_idx
  on padi_integrations (username_hash) where status = 'connected';
