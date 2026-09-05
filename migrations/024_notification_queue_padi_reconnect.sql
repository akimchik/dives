-- Relax the notification_type CHECK constraint (originally added in
-- migrations/014_notification_queue.sql) to also allow padi_reconnect.
alter table notification_queue
  drop constraint notification_queue_notification_type_check,
  add constraint notification_queue_notification_type_check
    check (notification_type in ('new_user_signup', 'dive_backup', 'padi_reconnect'));
