import type { FastifyInstance } from 'fastify';
import { config } from '../config';
import { logger } from '../lib/log';
import { getUserByIngestKey } from '../lib/users';

const log = logger('ingest');

interface MtxAuthRequest {
  user?: string;
  password?: string;
  ip?: string;
  action?: string;
  path?: string;
  protocol?: string;
  id?: string;
  query?: string;
}

/**
 * Zugangsprüfung für MediaMTX. OBS sendet an rtmp://host/live mit dem
 * Ingest-Key als Stream-Key, MediaMTX fragt hier nach, ob das erlaubt ist.
 * Kommt hier eine 401, lässt MediaMTX die Verbindung gar nicht erst zu.
 */
export async function ingestRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/ingest/auth', async (req, reply) => {
    const b = (req.body ?? {}) as MtxAuthRequest;
    const action = b.action ?? '';
    const path = b.path ?? '';

    // Internes Lesen (Relay, Vorschaubild) läuft über das Docker-Netz.
    if (action === 'read') {
      reply.code(200);
      return { ok: true };
    }

    if (action !== 'publish') {
      reply.code(401);
      return { error: 'action_not_allowed' };
    }

    const prefix = `${config.ingestPathPrefix}/`;
    if (!path.startsWith(prefix)) {
      log.warn(`Publish auf unerwartetem Pfad abgelehnt: ${path}`);
      reply.code(401);
      return { error: 'wrong_path' };
    }

    const key = path.slice(prefix.length);
    if (key === '') {
      reply.code(401);
      return { error: 'missing_key' };
    }

    const user = await getUserByIngestKey(key);
    if (!user) {
      log.warn(`Publish mit unbekanntem Ingest-Key abgelehnt (${b.ip ?? 'unbekannt'}).`);
      reply.code(401);
      return { error: 'unknown_key' };
    }
    if (user.is_blocked) {
      log.warn(`Publish eines gesperrten Nutzers abgelehnt: ${user.email}`);
      reply.code(401);
      return { error: 'blocked' };
    }

    log.info(`Publish erlaubt für ${user.email} über ${b.protocol ?? '?'}`);
    reply.code(200);
    return { ok: true };
  });

  app.get('/api/health', async () => ({
    ok: true,
    version: 1,
    time: new Date().toISOString(),
  }));
}
