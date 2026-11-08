-- Castbridge – Grundschema
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL UNIQUE,
  password_hash   text NOT NULL,
  display_name    text NOT NULL DEFAULT '',
  is_admin        boolean NOT NULL DEFAULT false,
  is_blocked      boolean NOT NULL DEFAULT false,
  language        text NOT NULL DEFAULT 'de',
  ingest_key      text NOT NULL UNIQUE,
  overlay_token   text NOT NULL UNIQUE,
  wizard_done     boolean NOT NULL DEFAULT false,
  settings        jsonb NOT NULL DEFAULT '{}'::jsonb,
  failed_logins   integer NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  text NOT NULL UNIQUE,
  note        text NOT NULL DEFAULT '',
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  used_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  user_agent  text NOT NULL DEFAULT '',
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions(user_id);

CREATE TABLE IF NOT EXISTS platform_accounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform           text NOT NULL,
  display_name       text NOT NULL DEFAULT '',
  channel_id         text NOT NULL DEFAULT '',
  channel_login      text NOT NULL DEFAULT '',
  connected_via      text NOT NULL DEFAULT 'manual',
  access_token_enc   text,
  refresh_token_enc  text,
  token_expires_at   timestamptz,
  scopes             text NOT NULL DEFAULT '',
  stream_key_enc     text,
  ingest_url         text NOT NULL DEFAULT '',
  extra              jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error         text,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, platform)
);

CREATE TABLE IF NOT EXISTS title_presets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         text NOT NULL,
  pinned        boolean NOT NULL DEFAULT false,
  use_count     integer NOT NULL DEFAULT 1,
  last_used_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, title)
);

CREATE TABLE IF NOT EXISTS stream_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at   timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz,
  title        text NOT NULL DEFAULT '',
  video_codec  text NOT NULL DEFAULT '',
  audio_codec  text NOT NULL DEFAULT '',
  width        integer,
  height       integer,
  fps          numeric(6,2),
  bitrate_kbps integer,
  peak_viewers integer NOT NULL DEFAULT 0,
  messages     integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS stream_sessions_user_idx ON stream_sessions(user_id, started_at DESC);

CREATE TABLE IF NOT EXISTS platform_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES stream_sessions(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform    text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  state       text NOT NULL DEFAULT 'live',
  last_error  text
);
CREATE INDEX IF NOT EXISTS platform_runs_session_idx ON platform_runs(session_id);

CREATE TABLE IF NOT EXISTS viewer_samples (
  id          bigserial PRIMARY KEY,
  session_id  uuid NOT NULL REFERENCES stream_sessions(id) ON DELETE CASCADE,
  platform    text NOT NULL,
  at          timestamptz NOT NULL DEFAULT now(),
  viewers     integer NOT NULL,
  chatters    integer NOT NULL DEFAULT 0,
  messages    integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS viewer_samples_session_idx ON viewer_samples(session_id, at);

CREATE TABLE IF NOT EXISTS chat_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id    uuid REFERENCES stream_sessions(id) ON DELETE CASCADE,
  platform      text NOT NULL,
  platform_msg  text NOT NULL DEFAULT '',
  author_id     text NOT NULL DEFAULT '',
  author        text NOT NULL DEFAULT '',
  color         text NOT NULL DEFAULT '',
  body          text NOT NULL DEFAULT '',
  fragments     jsonb NOT NULL DEFAULT '[]'::jsonb,
  badges        jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_bot        boolean NOT NULL DEFAULT false,
  deleted       boolean NOT NULL DEFAULT false,
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_messages_session_idx ON chat_messages(session_id, at DESC);

CREATE TABLE IF NOT EXISTS stream_events (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id  uuid REFERENCES stream_sessions(id) ON DELETE CASCADE,
  platform    text NOT NULL,
  type        text NOT NULL,
  actor       text NOT NULL DEFAULT '',
  amount      integer NOT NULL DEFAULT 0,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stream_events_session_idx ON stream_events(session_id, at);

CREATE TABLE IF NOT EXISTS anomalies (
  id          bigserial PRIMARY KEY,
  session_id  uuid NOT NULL REFERENCES stream_sessions(id) ON DELETE CASCADE,
  platform    text NOT NULL,
  type        text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS standby_assets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           text NOT NULL,
  original_name  text NOT NULL DEFAULT '',
  original_path  text NOT NULL,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS speedtests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mbps              numeric(8,2) NOT NULL,
  recommended_kbps  integer NOT NULL,
  at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id       bigserial PRIMARY KEY,
  user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  action   text NOT NULL,
  detail   jsonb NOT NULL DEFAULT '{}'::jsonb,
  at       timestamptz NOT NULL DEFAULT now()
);
