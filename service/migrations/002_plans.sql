-- Per-user storage allowance.
--
-- Storage is the one part of skym with real marginal cost, so it is the axis
-- the free/paid split runs along. A plan names the tier; the limit each tier
-- grants lives in the service config, not here, so changing a price does not
-- need a migration.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'free';

-- Bytes granted to this user specifically, overriding their plan's default.
-- Nullable on purpose: NULL means "whatever the plan says", so raising every
-- free user's allowance stays a config change. Set it to comp an individual
-- account without inventing a tier for them.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS storage_limit_bytes bigint;

-- Guarded rather than bare: migrations run on boot, so a re-run must not
-- throw and wedge every restart.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_storage_limit_nonneg'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_storage_limit_nonneg
      CHECK (storage_limit_bytes IS NULL OR storage_limit_bytes >= 0);
  END IF;
END $$;
