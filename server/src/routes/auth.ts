import type { FastifyInstance } from 'fastify';
import {
  SESSION_COOKIE,
  audit,
  clearSessionCookie,
  createSession,
  destroyAllSessions,
  destroySession,
  lockRemainingSeconds,
  noteLoginFailure,
  noteLoginSuccess,
  requireUser,
  setSessionCookie,
  type AuthedRequest,
} from '../lib/auth';
import { exec } from '../lib/db';
import { hashPassword, verifyPassword } from '../lib/crypto';
import { consumeInvite, findUsableInvite } from '../lib/invites';
import { createUser, getUserByEmail, publicUser } from '../lib/users';
import { BadRequest, body, email, oneOf, password, str } from '../lib/validate';
import { logger } from '../lib/log';

const log = logger('auth');

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/login', async (req: AuthedRequest, reply) => {
    const b = body(req.body);
    const mail = email(b);
    const pass = str(b, 'password', { min: 1, max: 200 });

    const user = await getUserByEmail(mail);
    // Gleiche Antwort für unbekannte Mail und falsches Passwort.
    if (!user) {
      await new Promise((r) => setTimeout(r, 300));
      throw new BadRequest('login_failed');
    }
    if (user.is_blocked) throw new BadRequest('account_blocked');

    const lockLeft = lockRemainingSeconds(user);
    if (lockLeft > 0) {
      reply.code(429);
      return { error: 'account_locked', retryAfterSec: lockLeft };
    }

    if (!verifyPassword(pass, user.password_hash)) {
      await noteLoginFailure(user);
      await new Promise((r) => setTimeout(r, 300));
      throw new BadRequest('login_failed');
    }

    await noteLoginSuccess(user);
    const token = await createSession(user.id, String(req.headers['user-agent'] ?? ''));
    setSessionCookie(reply, token);
    await audit(user.id, 'login');
    log.info(`Login: ${user.email}`);
    return { user: publicUser({ ...user, failed_logins: 0, locked_until: null }) };
  });

  app.post('/api/auth/logout', async (req: AuthedRequest, reply) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await destroySession(token);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req: AuthedRequest, reply) => {
    if (!req.user) {
      reply.code(401);
      return { error: 'not_authenticated' };
    }
    return { user: publicUser(req.user) };
  });

  app.post('/api/auth/language', async (req: AuthedRequest) => {
    const user = requireUser(req);
    const lang = oneOf(body(req.body), 'language', ['de', 'en'] as const);
    await exec('UPDATE users SET language = $2 WHERE id = $1', [user.id, lang]);
    return { language: lang };
  });

  app.post('/api/auth/password', async (req: AuthedRequest, reply) => {
    const user = requireUser(req);
    const b = body(req.body);
    const current = str(b, 'current', { min: 1, max: 200 });
    const next = password(b, 'next');
    if (!verifyPassword(current, user.password_hash)) throw new BadRequest('wrong_password');
    await exec('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, hashPassword(next)]);
    await destroyAllSessions(user.id);
    clearSessionCookie(reply);
    await audit(user.id, 'password_changed');
    return { ok: true, reloginRequired: true };
  });

  // ── Einladungen annehmen (ohne Login erreichbar) ────────────
  app.get('/api/invites/:token', async (req, reply) => {
    const token = (req.params as { token: string }).token;
    const invite = await findUsableInvite(token);
    if (!invite) {
      reply.code(404);
      return { valid: false, error: 'invite_invalid' };
    }
    return { valid: true, note: invite.note, expiresAt: invite.expires_at };
  });

  app.post('/api/invites/:token/accept', async (req: AuthedRequest, reply) => {
    const token = (req.params as { token: string }).token;
    const invite = await findUsableInvite(token);
    if (!invite) {
      reply.code(404);
      return { error: 'invite_invalid' };
    }

    const b = body(req.body);
    const mail = email(b);
    const pass = password(b);
    const displayName = str(b, 'displayName', { optional: true, max: 60 });
    const language = oneOf(b, 'language', ['de', 'en'] as const, 'de');

    if (await getUserByEmail(mail)) throw new BadRequest('email_taken');

    const user = await createUser({
      email: mail,
      password: pass,
      displayName: displayName === '' ? undefined : displayName,
      language,
    });
    const ok = await consumeInvite(invite.id, user.id);
    if (!ok) {
      // Wettlauf: zwei Leute mit demselben Link.
      await exec('DELETE FROM users WHERE id = $1', [user.id]);
      reply.code(409);
      return { error: 'invite_already_used' };
    }

    const session = await createSession(user.id, String(req.headers['user-agent'] ?? ''));
    setSessionCookie(reply, session);
    await audit(user.id, 'invite_accepted', { inviteId: invite.id });
    log.info(`Neues Konto über Einladung: ${user.email}`);
    return { user: publicUser(user) };
  });
}
