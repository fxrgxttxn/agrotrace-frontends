-- migrate:up
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  type varchar(32) NOT NULL CHECK (type IN
    ('LAB_ASSIGNED','LAB_RESULT','WAYBILL_INCOMING','RECALL','RECALL_TASK','OVERDUE','COMPLAINT','LAB_OVERDUE')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  channel varchar(16) NOT NULL DEFAULT 'IN_APP' CHECK (channel IN ('IN_APP','EMAIL','TELEGRAM')),
  delivery_status varchar(16) NOT NULL DEFAULT 'DELIVERED' CHECK (delivery_status IN ('PENDING','DELIVERED','FAILED','NOT_CONFIGURED')),
  attempts integer NOT NULL DEFAULT 0,
  is_read boolean NOT NULL DEFAULT false,
  seq bigserial UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_notifications_user ON notifications(user_id, is_read, created_at DESC) WHERE channel = 'IN_APP';
CREATE FUNCTION notify_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.channel = 'IN_APP' THEN
    PERFORM pg_notify('notifications', json_build_object('id', NEW.id, 'user_id', NEW.user_id)::text);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER t_notifications_notify AFTER INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION notify_notification();

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  actor_id uuid,
  action varchar(64) NOT NULL,
  entity_type varchar(64) NOT NULL,
  entity_id uuid,
  diff jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip inet,
  backend varchar(8) NOT NULL CHECK (backend IN ('express','django','laravel','seed','system')),
  request_id varchar(64),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX ix_audit_created ON audit_log(created_at DESC);
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM agrotrace_app;
GRANT SELECT, INSERT ON audit_log TO agrotrace_app;
-- migrate:down
DROP TABLE audit_log;
DROP TRIGGER t_notifications_notify ON notifications; DROP FUNCTION notify_notification();
DROP TABLE notifications;
