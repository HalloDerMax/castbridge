-- Laufzeit-Einstellungen, die der Admin in der Oberfläche ändern kann.
CREATE TABLE IF NOT EXISTS app_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO app_settings (key, value)
VALUES ('max_concurrent_streams', 'null'::jsonb)
ON CONFLICT (key) DO NOTHING;
