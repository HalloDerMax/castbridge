import { config } from '../config';
import { exec, one } from './db';

/** Einstellungen, die der Admin zur Laufzeit ändern kann. Fällt auf .env zurück. */
export async function getNumber(key: string, fallback: number): Promise<number> {
  const row = await one<{ value: unknown }>('SELECT value FROM app_settings WHERE key = $1', [key]);
  const v = row?.value;
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export async function setNumber(key: string, value: number | null): Promise<void> {
  await exec(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

export async function maxConcurrentStreams(): Promise<number> {
  return getNumber('max_concurrent_streams', config.maxConcurrentStreams);
}
