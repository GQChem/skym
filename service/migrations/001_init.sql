-- skym service, initial schema.
--
-- The op log is the source of truth: `charts.revision` is the last seq the
-- server assigned, and a chart's graph is the fold of its ops. Snapshots are a
-- cache we can always rebuild, which is why there is no graph column.

CREATE TABLE IF NOT EXISTS users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text UNIQUE NOT NULL,
  name        text,
  avatar_url  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- One row per provider account. Linking happens on a provider-asserted
-- VERIFIED email only: an unverified address must never merge into an existing
-- user, or account takeover is one signup away.
CREATE TABLE IF NOT EXISTS identities (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         text NOT NULL CHECK (provider IN ('google', 'github')),
  provider_user_id text NOT NULL,
  email            text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_user_id)
);

CREATE TABLE IF NOT EXISTS projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  -- How the agent finds this project without the user naming one: a git remote
  -- or folder name. Nullable and changeable on purpose — a project may be
  -- renamed, merged, or shared by several checkouts, so this is a hint for
  -- auto-attach, never the identity.
  repo_key    text,
  owner_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Scoped per owner: two users may each have a project for the same repo path.
CREATE UNIQUE INDEX IF NOT EXISTS projects_owner_repo_key
  ON projects (owner_id, repo_key) WHERE repo_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS project_members (
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member', 'viewer')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS charts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- The client's own chart id (a slug). Unique per project so a resumed chat
  -- reattaches to its chart rather than forking a new one.
  slug        text NOT NULL,
  title       text NOT NULL,
  -- Last seq assigned. Doubles as the optimistic-concurrency token.
  revision    bigint NOT NULL DEFAULT 0,
  vocab       jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, slug)
);

-- Append-only. seq is assigned here, never by the client: two agents editing
-- one chart both propose seq N, and the client's value is only a hint.
CREATE TABLE IF NOT EXISTS ops (
  chart_id    uuid NOT NULL REFERENCES charts(id) ON DELETE CASCADE,
  seq         bigint NOT NULL,
  -- The client-minted Entry.id. Makes ingest idempotent under retry.
  op_id       uuid NOT NULL,
  at          bigint NOT NULL,
  author      text NOT NULL,
  op          jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chart_id, seq)
);

-- The dedupe key: a redelivered batch hits this and is skipped.
CREATE UNIQUE INDEX IF NOT EXISTS ops_chart_op_id ON ops (chart_id, op_id);

CREATE TABLE IF NOT EXISTS figures (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chart_id    uuid NOT NULL REFERENCES charts(id) ON DELETE CASCADE,
  -- Matches Figure.file in the op, which references the blob out of band.
  file        text NOT NULL,
  mime        text NOT NULL,
  bytes       bigint NOT NULL,
  -- Path under the mounted volume. Railway's container FS is ephemeral, so a
  -- figure written outside the volume disappears on the next deploy.
  storage_key text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chart_id, file)
);

-- Instructions queued from the web UI for a local agent to claim and run.
CREATE TABLE IF NOT EXISTS commands (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chart_id    uuid NOT NULL REFERENCES charts(id) ON DELETE CASCADE,
  node_id     text,
  verb        text NOT NULL DEFAULT 'work_on',
  body        text,
  status      text NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'claimed', 'running', 'done', 'failed', 'cancelled')),
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  claimed_by  text,
  claimed_at  timestamptz,
  finished_at timestamptz,
  result      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS commands_queued ON commands (chart_id, status) WHERE status = 'queued';

-- Device-code pairing: the agent polls with device_code until the user
-- approves in a browser, then exchanges it for a long-lived agent token.
CREATE TABLE IF NOT EXISTS pairings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_code  text UNIQUE NOT NULL,
  -- Short, human-readable, typed into the browser by the user.
  user_code    text UNIQUE NOT NULL,
  user_id      uuid REFERENCES users(id) ON DELETE CASCADE,
  approved_at  timestamptz,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Long-lived credential the MCP server stores in ~/.skym/. Only the hash is
-- kept, so a database leak does not hand over working agent tokens.
CREATE TABLE IF NOT EXISTS agent_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text UNIQUE NOT NULL,
  label       text,
  last_used_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text UNIQUE NOT NULL,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
