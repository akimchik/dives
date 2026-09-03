alter table users alter column password_hash drop not null;
alter table users add column oidc_subject text unique;
alter table users add column is_admin boolean not null default false;
