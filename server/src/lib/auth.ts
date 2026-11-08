import type { FastifyReply, FastifyRequest } from 'fastify';
import { exec, one } from './db';
import { randomToken, sha256 } from './crypto';
import { getUserById, type UserRow } from './users';
import { config } from '../config';

export const SESSION_COOKIE = 'cb_session';
const SESSION_DAYS = 30;

export async function createSession(userId: string, userAgent: string): Promise<string> {
  const token = randomToken(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await exec(
    'INSERT INTO auth_sessions (user_id, token_hash, user_agent, expires_at) VALUES ($1, $2, $3, $4)',
    [userId, sha256(token), userAgent.slice(0, 300), expires],
  );
  return token;
}

export async function destroySession(token: string): Promise<void> {
  await exec('DELETE FROM auth_sessions WHERE token_hash = $1', [sha256(token)]);
}

export async function destroyAllSessions(userId: string): Promise<void> {
  await exec('DELETE FROM auth_sessions WHERE user_id = $1', [userId]);
}

export async function userFromToken(token: string): Promise<UserRow | null> {
  const row = await one<{ user_id: string }>(
    'SELECT user_id FROM auth_sessions WHERE token_hash = $1 AND expires_at > now()',
    [sha256(token)],
  );
  if (!row) return null;
  const user = await getUserById(row.user_id);
  if (!user || user.is_blocked) return null;
  return user;
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.publicUrl.startsWith('https://'),
    maxAge: SESSION_DAYS * 86_400,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export interface AuthedRequest extends FastifyRequest {
  user?: UserRow;
}

/** Hängt req.user an, wenn ein gültiges Session-Cookie vorliegt. */
export async function attachUser(req: AuthedRequest): Promise<void> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return;
  const user = await userFromToken(token);
  if (user) req.user = user;
}

export function requireUser(req: AuthedRequest): UserRow {
  if (!req.user) {
    const err = new Error('not_authenticated') as Error & { statusCode?: number };
    err.statusCode = 401;
    throw err;
  }
  return req.user;
}

export function requireAdmin(req: AuthedRequest): UserRow {
  const user = requireUser(req);
  if (!user.is_admin) {
    const err = new Error('not_admin') as Error & { statusCode?: number };
    err.statusCode = 403;
    throw err;
  }
  return user;
}

/** Login-Bremse: nach 10 Fehlversuchen 15 Minuten Sperre. */
export const LOGIN_MAX_FAILURES = 10;
export const LOGIN_LOCK_MINUTES = 15;

export async function noteLoginFailure(user: UserRow): Promise<void> {
  const next = user.failed_logins + 1;
  if (next >= LOGIN_MAX_FAILURES) {
    await exec('UPDATE users SET failed_logins = 0, locked_until = now() + ($2 || \' minutes\')::interval WHERE id = $1', [
      user.id,
      String(LOGIN_LOCK_MINUTES),
    ]);
  } else {
    await exec('UPDATE users SET failed_logins = $2 WHERE id = $1', [user.id, next]);
  }
}

export async function noteLoginSuccess(user: UserRow): Promise<void> {
  await exec('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [user.id]);
}

export function lockRemainingSeconds(user: UserRow): number {
  if (!user.locked_until) return 0;
  const diff = new Date(user.locked_until).getTime() - Date.now();
  return diff > 0 ? Math.ceil(diff / 1000) : 0;
}

export async function audit(userId: string | null, action: string, detail: Record<string, unknown> = {}): Promise<void> {
  await exec('INSERT INTO audit_log (user_id, action, detail) VALUES ($1, $2, $3::jsonb)', [
    userId,
    action,
    JSON.stringify(detail),
  ]);
}
