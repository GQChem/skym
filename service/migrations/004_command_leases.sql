ALTER TABLE commands ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE commands ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
ALTER TABLE commands ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS commands_creator_idempotency
  ON commands (created_by, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS commands_claimable
  ON commands (chart_id, created_at)
  WHERE status IN ('queued', 'claimed', 'running');
