import { one, query, exec } from './db';
import { hashPassword, randomIngestKey, randomToken } from './crypto';
import { defaultOverlaySettings, defaultUserSettings, type UserSettings } from '../types';
import { config } from '../config';
import { logger } from './log';

const log = logger('users');

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  is_admin: boolean;
  is_blocked: boolean;
  language: string;
  ingest_key: string;
  overlay_token: string;
  wizard_done: boolean;
  settings: Partial<UserSettings>;
  failed_logins: number;
  locked_until: Date | null;
  last_login_at: Date | null;
  created_at: Date;
}

export function mergeSettings(raw: Partial<UserSettings> | null | undefined): UserSettings {
  const base = { ...defaultUserSettings, ...(raw ?? {}) };
  return {
    ...base,
    overlay: { ...defaultOverlaySettings, ...(raw?.overlay ?? {}) },
    customBotNames: Array.isArray(base.customBotNames) ? base.customBotNames : [],
    perPlatformTitles: base.perPlatformTitles ?? {},
    categoryIds: base.categoryIds ?? {},
  };
}

export async function getUserById(id: string): Promise<UserRow | null> {
  return one<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
}

export async function getUserByEmail(email: string): Promise<UserRow | null> {
  return one<UserRow>('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
}

export async function getUserByIngestKey(key: string): Promise<UserRow | null> {
  return one<UserRow>('SELECT * FROM users WHERE ingest_key = $1', [key]);
}

export async function getUserByOverlayToken(token: string): Promise<UserRow | null> {
  return one<UserRow>('SELECT * FROM users WHERE overlay_token = $1', [token]);
}

export async function listUsers(): Promise<UserRow[]> {
  return query<UserRow>('SELECT * FROM users ORDER BY created_at ASC');
}

export async function createUser(params: {
  email: string;
  password: string;
  displayName?: string;
  isAdmin?: boolean;
  language?: string;
}): Promise<UserRow> {
  const row = await one<UserRow>(
    `INSERT INTO users (email, password_hash, display_name, is_admin, language, ingest_key, overlay_token, settings)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     RETURNING *`,
    [
      params.email.trim(),
      hashPassword(params.password),
      params.displayName ?? params.email.split('@')[0],
      params.isAdmin ?? false,
      params.language ?? 'de',
      randomIngestKey(),
      randomToken(24),
      JSON.stringify(defaultUserSettings),
    ],
  );
  if (!row) throw new Error('Nutzer konnte nicht angelegt werden.');
  return row;
}

export async function updateSettings(userId: string, patch: Partial<UserSettings>): Promise<UserSettings> {
  const user = await getUserById(userId);
  if (!user) throw new Error('Nutzer nicht gefunden');
  const merged = mergeSettings({ ...mergeSettings(user.settings), ...patch });
  await exec('UPDATE users SET settings = $2::jsonb WHERE id = $1', [userId, JSON.stringify(merged)]);
  return merged;
}

export async function rotateIngestKey(userId: string): Promise<string> {
  const key = randomIngestKey();
  await exec('UPDATE users SET ingest_key = $2 WHERE id = $1', [userId, key]);
  return key;
}

export async function rotateOverlayToken(userId: string): Promise<string> {
  const token = randomToken(24);
  await exec('UPDATE users SET overlay_token = $2 WHERE id = $1', [userId, token]);
  return token;
}

/** Legt beim ersten Start den Admin an, falls ADMIN_EMAIL/ADMIN_PASSWORD gesetzt sind. */
export async function ensureAdmin(): Promise<void> {
  if (config.adminEmail === '' || config.adminPassword === '') {
    const anyAdmin = await one<{ id: string }>('SELECT id FROM users WHERE is_admin LIMIT 1');
    if (!anyAdmin) {
      log.warn('Kein Admin vorhanden und ADMIN_EMAIL/ADMIN_PASSWORD nicht gesetzt.');
    }
    return;
  }
  const existing = await getUserByEmail(config.adminEmail);
  if (existing) {
    if (!existing.is_admin) {
      await exec('UPDATE users SET is_admin = true WHERE id = $1', [existing.id]);
      log.info(`Nutzer ${config.adminEmail} zum Admin gemacht.`);
    }
    return;
  }
  await createUser({
    email: config.adminEmail,
    password: config.adminPassword,
    isAdmin: true,
    displayName: 'Admin',
  });
  log.info(`Admin-Konto angelegt: ${config.adminEmail}`);
}

export function publicUser(user: UserRow): {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  language: string;
  wizardDone: boolean;
  ingestKey: string;
  overlayToken: string;
  settings: UserSettings;
} {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    isAdmin: user.is_admin,
    language: user.language,
    wizardDone: user.wizard_done,
    ingestKey: user.ingest_key,
    overlayToken: user.overlay_token,
    settings: mergeSettings(user.settings),
  };
}
