import { exec, one, query } from '../lib/db';
import { decrypt, encrypt } from '../lib/crypto';
import type { PlatformId } from '../config';

export interface PlatformAccountRow {
  id: string;
  user_id: string;
  platform: PlatformId;
  display_name: string;
  channel_id: string;
  channel_login: string;
  connected_via: 'oauth' | 'manual';
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  token_expires_at: Date | null;
  scopes: string;
  stream_key_enc: string | null;
  ingest_url: string;
  extra: Record<string, unknown>;
  last_error: string | null;
  updated_at: Date;
  created_at: Date;
}

export async function getAccount(userId: string, platform: PlatformId): Promise<PlatformAccountRow | null> {
  return one<PlatformAccountRow>('SELECT * FROM platform_accounts WHERE user_id = $1 AND platform = $2', [
    userId,
    platform,
  ]);
}

export async function listAccounts(userId: string): Promise<PlatformAccountRow[]> {
  return query<PlatformAccountRow>('SELECT * FROM platform_accounts WHERE user_id = $1', [userId]);
}

export async function upsertAccount(params: {
  userId: string;
  platform: PlatformId;
  displayName?: string;
  channelId?: string;
  channelLogin?: string;
  connectedVia?: 'oauth' | 'manual';
  accessToken?: string | null;
  refreshToken?: string | null;
  tokenExpiresAt?: Date | null;
  scopes?: string;
  streamKey?: string | null;
  ingestUrl?: string;
  extra?: Record<string, unknown>;
}): Promise<PlatformAccountRow> {
  const row = await one<PlatformAccountRow>(
    `INSERT INTO platform_accounts
       (user_id, platform, display_name, channel_id, channel_login, connected_via,
        access_token_enc, refresh_token_enc, token_expires_at, scopes, stream_key_enc, ingest_url, extra, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb, now())
     ON CONFLICT (user_id, platform) DO UPDATE SET
       display_name   = COALESCE(NULLIF(EXCLUDED.display_name, ''), platform_accounts.display_name),
       channel_id     = COALESCE(NULLIF(EXCLUDED.channel_id, ''), platform_accounts.channel_id),
       channel_login  = COALESCE(NULLIF(EXCLUDED.channel_login, ''), platform_accounts.channel_login),
       connected_via  = EXCLUDED.connected_via,
       access_token_enc  = COALESCE(EXCLUDED.access_token_enc, platform_accounts.access_token_enc),
       refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, platform_accounts.refresh_token_enc),
       token_expires_at  = COALESCE(EXCLUDED.token_expires_at, platform_accounts.token_expires_at),
       scopes         = COALESCE(NULLIF(EXCLUDED.scopes, ''), platform_accounts.scopes),
       stream_key_enc = COALESCE(EXCLUDED.stream_key_enc, platform_accounts.stream_key_enc),
       ingest_url     = COALESCE(NULLIF(EXCLUDED.ingest_url, ''), platform_accounts.ingest_url),
       extra          = platform_accounts.extra || EXCLUDED.extra,
       last_error     = NULL,
       updated_at     = now()
     RETURNING *`,
    [
      params.userId,
      params.platform,
      params.displayName ?? '',
      params.channelId ?? '',
      params.channelLogin ?? '',
      params.connectedVia ?? 'manual',
      params.accessToken === undefined || params.accessToken === null ? null : encrypt(params.accessToken),
      params.refreshToken === undefined || params.refreshToken === null ? null : encrypt(params.refreshToken),
      params.tokenExpiresAt ?? null,
      params.scopes ?? '',
      params.streamKey === undefined || params.streamKey === null ? null : encrypt(params.streamKey),
      params.ingestUrl ?? '',
      JSON.stringify(params.extra ?? {}),
    ],
  );
  if (!row) throw new Error('Plattform-Konto konnte nicht gespeichert werden.');
  return row;
}

export async function deleteAccount(userId: string, platform: PlatformId): Promise<void> {
  await exec('DELETE FROM platform_accounts WHERE user_id = $1 AND platform = $2', [userId, platform]);
}

export async function setAccountError(id: string, message: string | null): Promise<void> {
  await exec('UPDATE platform_accounts SET last_error = $2, updated_at = now() WHERE id = $1', [
    id,
    message === null ? null : message.slice(0, 500),
  ]);
}

export async function saveTokens(
  id: string,
  tokens: { accessToken: string; refreshToken?: string | null; expiresInSec?: number | null },
): Promise<void> {
  await exec(
    `UPDATE platform_accounts
        SET access_token_enc = $2,
            refresh_token_enc = COALESCE($3, refresh_token_enc),
            token_expires_at = $4,
            updated_at = now()
      WHERE id = $1`,
    [
      id,
      encrypt(tokens.accessToken),
      tokens.refreshToken ? encrypt(tokens.refreshToken) : null,
      tokens.expiresInSec ? new Date(Date.now() + tokens.expiresInSec * 1000) : null,
    ],
  );
}

export async function patchExtra(id: string, extra: Record<string, unknown>): Promise<void> {
  await exec('UPDATE platform_accounts SET extra = extra || $2::jsonb, updated_at = now() WHERE id = $1', [
    id,
    JSON.stringify(extra),
  ]);
}

export function accessToken(acc: PlatformAccountRow): string | null {
  return decrypt(acc.access_token_enc);
}
export function refreshToken(acc: PlatformAccountRow): string | null {
  return decrypt(acc.refresh_token_enc);
}
export function streamKey(acc: PlatformAccountRow): string | null {
  return decrypt(acc.stream_key_enc);
}
export function tokenExpired(acc: PlatformAccountRow, skewSec = 120): boolean {
  if (!acc.token_expires_at) return false;
  return new Date(acc.token_expires_at).getTime() - skewSec * 1000 < Date.now();
}
