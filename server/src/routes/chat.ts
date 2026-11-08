import type { FastifyInstance } from 'fastify';
import { requireUser, type AuthedRequest } from '../lib/auth';
import { mergeSettings, updateSettings } from '../lib/users';
import { body, bool, int, strList } from '../lib/validate';
import { chatHub } from '../chat/hub';
import { KNOWN_BOTS } from '../chat/bots';

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/chat/recent', async (req: AuthedRequest) => {
    const user = requireUser(req);
    const q = req.query as { limit?: string; hideBots?: string };
    const settings = mergeSettings(user.settings);
    const limit = Math.min(Math.max(Number(q.limit ?? 100), 1), 200);
    const hideBots = q.hideBots === undefined ? settings.hideBots : q.hideBots === 'true';
    return {
      messages: chatHub.recent(user.id, limit, hideBots),
      rates: chatHub.rates(user.id),
      connections: chatHub.connectionState(user.id),
    };
  });

  app.post('/api/chat/connect', async (req: AuthedRequest) => {
    const user = requireUser(req);
    await chatHub.ensureForUser(user.id);
    return { connections: chatHub.connectionState(user.id) };
  });

  app.get('/api/chat/bots', async (req: AuthedRequest) => {
    const user = requireUser(req);
    const settings = mergeSettings(user.settings);
    return {
      known: KNOWN_BOTS,
      hideBots: settings.hideBots,
      custom: settings.customBotNames,
    };
  });

  app.post('/api/chat/bots', async (req: AuthedRequest) => {
    const user = requireUser(req);
    const b = body(req.body);
    const settings = await updateSettings(user.id, {
      hideBots: bool(b, 'hideBots', false),
      customBotNames: strList(b, 'custom', 50).map((s) => s.toLowerCase()),
    });
    return { hideBots: settings.hideBots, custom: settings.customBotNames };
  });

  app.post('/api/chat/history/clear', async (req: AuthedRequest) => {
    const user = requireUser(req);
    const days = int(body(req.body), 'olderThanDays', { min: 0, max: 3650, fallback: 0 });
    const { exec } = await import('../lib/db');
    const removed = await exec(
      `DELETE FROM chat_messages WHERE user_id = $1 AND at < now() - ($2 || ' days')::interval`,
      [user.id, String(days)],
    );
    return { removed };
  });
}
