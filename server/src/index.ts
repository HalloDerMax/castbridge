import './env';

import * as fs from 'fs';
import * as path from 'path';
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';

import { config } from './config';
import { logger } from './lib/log';
import { bus } from './lib/bus';
import { migrate, pool, waitForDatabase } from './lib/db';
import { attachUser, type AuthedRequest } from './lib/auth';
import { ensureAdmin } from './lib/users';
import { relayManager } from './relay/manager';
import { ensureDefaultImage } from './relay/standby';
import { statsCollector } from './stats/collector';
import { chatHub } from './chat/hub';
import { authRoutes } from './routes/auth';
import { ingestRoutes } from './routes/ingest';
import { streamRoutes } from './routes/stream';
import { platformRoutes } from './routes/platforms';
import { chatRoutes } from './routes/chat';
import { overlayRoutes } from './routes/overlay';
import { settingsRoutes } from './routes/settings';
import { statsRoutes } from './routes/stats';
import { adminRoutes } from './routes/admin';
import { wsRoutes } from './routes/ws';

const log = logger('server');

/** Pfade, die die Einzelseiten-App selbst auflöst. */
const SPA_ROUTES = [
  '/',
  '/login',
  '/einladung',
  '/einrichtung',
  '/dashboard',
  '/chat',
  '/overlay-editor',
  '/statistik',
  '/einstellungen',
  '/admin',
  '/overlay',
];

function publicDir(): string | null {
  const candidates = [
    path.resolve(process.cwd(), 'public'),
    path.resolve(__dirname, '..', 'public'),
    path.resolve(__dirname, '..', '..', 'web', 'dist'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return null;
}

/** Baut die App ohne sie zu starten. Wird auch vom Rauchtest benutzt. */
export async function build(): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify({
    logger: false,
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: true,
  });

  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(websocket, { options: { maxPayload: 256 * 1024 } });
  await app.register(multipart, {
    limits: { fileSize: 300 * 1024 * 1024, files: 1 },
  });

  // JSON mit Rohtext: die Kick-Webhooks werden darüber signaturgeprüft.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, raw, done) => {
    (req as unknown as { rawBody?: string }).rawBody = String(raw);
    if (raw === '' ) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(String(raw)));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // Speedtest: Rohdaten nur zählen, nicht aufbewahren.
  app.addContentTypeParser('application/octet-stream', (req, payload, done) => {
    const start = process.hrtime.bigint();
    let bytes = 0;
    payload.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
    });
    payload.on('end', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1_000_000;
      (req as unknown as { speedtest?: { bytes: number; ms: number } }).speedtest = { bytes, ms };
      done(null, {});
    });
    payload.on('error', (err) => done(err, undefined));
  });

  app.addHook('onRequest', async (req: FastifyRequest) => {
    await attachUser(req as AuthedRequest);
  });

  app.setErrorHandler((err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) log.error(`${req.method} ${req.url}`, err);
    else log.debug(`${req.method} ${req.url} -> ${status} ${err.message}`);
    reply.code(status).send({ error: err.message === '' ? 'request_failed' : err.message });
  });

  await app.register(ingestRoutes);
  await app.register(authRoutes);
  await app.register(streamRoutes);
  await app.register(platformRoutes);
  await app.register(chatRoutes);
  await app.register(overlayRoutes);
  await app.register(settingsRoutes);
  await app.register(statsRoutes);
  await app.register(adminRoutes);
  await app.register(wsRoutes);

  const dir = publicDir();
  if (dir) {
    await app.register(fastifyStatic, { root: dir, prefix: '/', index: ['index.html'], wildcard: false });
    const indexHtml = path.join(dir, 'index.html');
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== 'GET' || req.url.startsWith('/api/')) {
        reply.code(404).send({ error: 'not_found' });
        return;
      }
      const base = '/' + (req.url.split('?')[0].split('/')[1] ?? '');
      if (SPA_ROUTES.includes(base) || SPA_ROUTES.includes(req.url)) {
        reply.type('text/html').send(fs.createReadStream(indexHtml));
        return;
      }
      reply.code(404).send({ error: 'not_found' });
    });
    log.info(`Oberfläche wird ausgeliefert aus ${dir}`);
  } else {
    log.warn('Kein gebautes Frontend gefunden (web/dist). Es läuft nur die API.');
  }

  return app;
}

async function main(): Promise<void> {
  log.info(`Castbridge startet (${config.env}) ...`);

  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.uploadDir, { recursive: true });
  fs.mkdirSync(config.standbyDir, { recursive: true });
  fs.mkdirSync(config.thumbDir, { recursive: true });

  await waitForDatabase();
  await migrate();
  await ensureAdmin();
  await bus.start();
  await ensureDefaultImage().catch((err) => log.warn('Standardbild', err));

  relayManager.start();
  statsCollector.start();

  const app = await build();
  await app.listen({ port: config.port, host: '0.0.0.0' });
  log.info(`Bereit auf Port ${config.port}. Öffentliche Adresse: ${config.publicUrl}`);
  log.info(`OBS-Server: rtmp://${config.ingestHost}:${config.ingestRtmpPort}/${config.ingestPathPrefix}`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} erhalten - fahre herunter.`);
    try {
      await app.close();
      statsCollector.stop();
      await relayManager.stop();
      await chatHub.stopAll();
      await bus.stop();
      await pool.end();
    } catch (err) {
      log.warn('Fehler beim Herunterfahren', err);
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => log.error('Unbehandelte Ablehnung', reason));
  process.on('uncaughtException', (err) => log.error('Unbehandelter Fehler', err));
}

// Nur starten, wenn die Datei direkt ausgeführt wird. Beim Import (Rauchtest)
// soll nichts von alleine losrennen.
if (require.main === module) {
  void main().catch((err) => {
    log.error('Start fehlgeschlagen', err);
    process.exit(1);
  });
}
