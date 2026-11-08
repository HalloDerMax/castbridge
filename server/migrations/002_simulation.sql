-- Castbridge – Viewbot-Simulator & Erkennungstest
-- Synthetische Zuschauerdaten werden IMMER mit synthetic=true geführt,
-- damit sich Simulation und Messung jederzeit auseinanderhalten lassen.

ALTER TABLE viewer_samples  ADD COLUMN IF NOT EXISTS synthetic boolean NOT NULL DEFAULT false;
ALTER TABLE viewer_samples  ADD COLUMN IF NOT EXISTS run_id uuid;
ALTER TABLE stream_sessions ADD COLUMN IF NOT EXISTS has_simulation boolean NOT NULL DEFAULT false;
ALTER TABLE anomalies       ADD COLUMN IF NOT EXISTS run_id uuid;
ALTER TABLE anomalies       ADD COLUMN IF NOT EXISTS score numeric(6,3) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS sim_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid REFERENCES stream_sessions(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  scenario      text NOT NULL,
  platform      text NOT NULL DEFAULT 'twitch',
  params        jsonb NOT NULL DEFAULT '{}'::jsonb,
  mode          text NOT NULL DEFAULT 'offline',   -- offline | live
  state         text NOT NULL DEFAULT 'running',   -- running | done | stopped
  expected      jsonb NOT NULL DEFAULT '[]'::jsonb, -- Muster, die anschlagen SOLLTEN
  detected      jsonb NOT NULL DEFAULT '[]'::jsonb, -- Muster, die angeschlagen HABEN
  verdict       text NOT NULL DEFAULT '',
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX IF NOT EXISTS sim_runs_user_idx ON sim_runs(user_id, started_at DESC);

CREATE INDEX IF NOT EXISTS viewer_samples_synth_idx ON viewer_samples(session_id, synthetic);
