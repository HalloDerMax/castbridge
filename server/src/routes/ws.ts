import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { bus, type BusMessage } from '../lib/bus';
import { SESSION_COOKIE, userFromToken } from '../lib/auth';
import { logger } from '../lib/log';
import { getUserByOverlayToken, mergeSettings } from '../lib/users';
import { chatHub } from '../chat/hub';
import { relayManager } from '../relay/manager';
import { thumbnails } from '../relay/thumbnail';
import { buildPlatformStatuses } from './stream';

const log = logger('ws');

const PING_MS = 25_000;

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === socket.OPEN) {
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      /* Verbindung ist weg */
    }
  }
}

function heartbeat(socket: WebSocket): () => void {
  let alive = true;
  socket.on('pong', () => {
    alive = true;
  });
  const timer = setInterval(() => {
    if (!alive) {
      socket.terminate();
      return;
    }
    alive = false;
    try {
      socket.ping();
    } catch {
      /* egal */
    }
  }, PING_MS);
  timer.unref();
  return () => clearInterval(timer);
}

export async function wsRoutes(app: FastifyInstance): Promise<void> {
  /** Dashboard: alles, was ein eingeloggter Nutzer sehen darf. */
  app.get('/ws', { websocket: true }, async (socket: WebSocket, req: FastifyRequest) => {
    const token = req.cookies?.[SESSION_COOKIE];
    const user = token ? await userFromToken(token) : null;
    if (!user) {
      send(socket, { type: 'error', code: 'not_authenticated' });
      socket.close();
      return;
    }

    const stopBeat = heartbeat(socket);
    const unsubscribe = bus.subscribe(user.id, (msg: BusMessage) => send(socket, msg.event));

    // Startzustand, damit die Oberfläche sofort stimmt.
    send(socket, { type: 'signal', signal: relayManager.signal(user.id) });
    for (const status of await buildPlatformStatuses(user)) {
      send(socket, { type: 'platform', status });
    }
    const settings = mergeSettings(user.settings);
    for (const message of chatHub.recent(user.id, 60, settings.hideBots)) {
      send(socket, { type: 'chat', message });
    }
    if (thumbnails.exists(user.id)) {
      send(socket, {
        type: 'preview',
        url: `/api/stream/preview.jpg?t=${Date.now()}`,
        at: new Date(Date.now() - (thumbnails.ageSeconds(user.id) ?? 0) * 1000).toISOString(),
      });
    }

    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string };
        if (msg.type === 'ping') send(socket, { type: 'pong' });
      } catch {
        /* Unsinn ignorieren */
      }
    });

    socket.on('close', () => {
      unsubscribe();
      stopBeat();
    });
  });

  /** Overlay für die OBS-Browserquelle: nur Chat und Aussehen, nur mit Token. */
  app.get('/overlay-ws', { websocket: true }, async (socket: WebSocket, req: FastifyRequest) => {
    const tokenRaw = (req.query as { token?: string }).token;
    const user = tokenRaw ? await getUserByOverlayToken(tokenRaw) : null;
    if (!user || user.is_blocked) {
      send(socket, { type: 'error', code: 'unknown_token' });
      socket.close();
      return;
    }

    const stopBeat = heartbeat(socket);
    const settings = mergeSettings(user.settings);

    const unsubscribe = bus.subscribe(user.id, (msg: BusMessage) => {
      const e = msg.event;
      if (
        e.type === 'chat' ||
        e.type === 'chat:delete' ||
        e.type === 'chat:purge' ||
        e.type === 'overlay:settings'
      ) {
        if (e.type === 'chat' && settings.overlay.hideBots && e.message.isBot) return;
        send(socket, e);
      }
    });

    send(socket, { type: 'overlay:settings', settings: settings.overlay });
    for (const message of chatHub.recent(user.id, settings.overlay.maxMessages, settings.overlay.hideBots)) {
      send(socket, { type: 'chat', message });
    }

    socket.on('close', () => {
      unsubscribe();
      stopBeat();
    });

    log.debug(`Overlay verbunden für ${user.email}`);
  });
}
