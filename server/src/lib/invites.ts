import { exec, one, query } from './db';
import { randomToken, sha256 } from './crypto';
import { config } from '../config';

export interface InviteRow {
  id: string;
  token_hash: string;
  note: string;
  created_by: string | null;
  expires_at: Date;
  used_at: Date | null;
  used_by: string | null;
  created_at: Date;
}

export async function createInvite(params: {
  createdBy: string;
  note?: string;
  validDays?: number;
}): Promise<{ invite: InviteRow; url: string; token: string }> {
  const token = randomToken(24);
  const days = Math.min(Math.max(params.validDays ?? 7, 1), 90);
  const invite = await one<InviteRow>(
    `INSERT INTO invites (token_hash, note, created_by, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' days')::interval)
     RETURNING *`,
    [sha256(token), (params.note ?? '').slice(0, 200), params.createdBy, String(days)],
  );
  if (!invite) throw new Error('Einladung konnte nicht erzeugt werden.');
  return { invite, token, url: `${config.publicUrl}/einladung/${token}` };
}

export async function findUsableInvite(token: string): Promise<InviteRow | null> {
  return one<InviteRow>(
    'SELECT * FROM invites WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()',
    [sha256(token)],
  );
}

export async function consumeInvite(inviteId: string, userId: string): Promise<boolean> {
  const n = await exec('UPDATE invites SET used_at = now(), used_by = $2 WHERE id = $1 AND used_at IS NULL', [
    inviteId,
    userId,
  ]);
  return n === 1;
}

export async function listInvites(): Promise<(InviteRow & { used_email: string | null; creator_email: string | null })[]> {
  return query<InviteRow & { used_email: string | null; creator_email: string | null }>(
    `SELECT i.*, u.email AS used_email, c.email AS creator_email
       FROM invites i
       LEFT JOIN users u ON u.id = i.used_by
       LEFT JOIN users c ON c.id = i.created_by
      ORDER BY i.created_at DESC
      LIMIT 200`,
  );
}

export async function deleteInvite(id: string): Promise<void> {
  await exec('DELETE FROM invites WHERE id = $1 AND used_at IS NULL', [id]);
}
