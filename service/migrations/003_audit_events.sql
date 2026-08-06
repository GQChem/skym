-- Durable record of security- and ownership-sensitive actions.
CREATE TABLE IF NOT EXISTS audit_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  event       text NOT NULL,
  target_type text,
  target_id   text,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_events_actor_created
  ON audit_events (actor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS audit_events_event_created
  ON audit_events (event, created_at DESC);
