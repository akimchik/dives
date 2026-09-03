create table notification_queue (
  id bigserial primary key,
  recipient_email text not null,
  notification_type text not null check (notification_type in ('bom_uploaded', 'first_check', 'status_change')),
  idempotency_key text not null unique,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts int not null default 0,
  max_attempts int not null default 8,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index notification_queue_claim_idx on notification_queue (next_attempt_at) where status = 'pending';
create index notification_queue_recipient_idx on notification_queue (recipient_email, status);
create index notification_queue_sending_idx on notification_queue (locked_at) where status = 'sending';
