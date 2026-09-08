-- Backs issue #14's PADI backup feature: backup_done_at is set the first time a full
-- logbook backup succeeds, backup_prompt_dismissed_at when the user explicitly skips the
-- nudge shown on their first "Create in PADI" upload. The upload nudge shows only while both
-- are null.
alter table padi_integrations
  add column backup_done_at timestamptz,
  add column backup_prompt_dismissed_at timestamptz;
