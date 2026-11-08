import { EventEmitter } from 'events';
import { config } from '../config';
import { logger } from './log';
import type { AppEvent } from '../types';

const log = logger('bus');

export interface BusMessage {
  userId: string;
  event: AppEvent;
}

type Handler = (msg: BusMessage) => void;

/**
 * Ereignis-Verteiler. Läuft ohne Redis vollständig im Prozess (für einen
 * Server genau richtig). Ist REDIS_URL gesetzt, werden Ereignisse zusätzlich
 * über Redis verteilt, damit mehrere App-Instanzen zusammenarbeiten können.
 */
class Bus {
  private readonly local = new EventEmitter();
  private pub: import('ioredis').Redis | null = null;
  private sub: import('ioredis').Redis | null = null;
  private readonly channel = 'castbridge:events';

  constructor() {
    this.local.setMaxListeners(0);
  }

  async start(): Promise<void> {
    if (!config.redisUrl) {
      log.info('Kein REDIS_URL - Ereignisse laufen prozessintern.');
      return;
    }
    try {
      const { default: Redis } = await import('ioredis');
      this.pub = new Redis(config.redisUrl, { lazyConnect: false, maxRetriesPerRequest: null });
      this.sub = new Redis(config.redisUrl, { lazyConnect: false, maxRetriesPerRequest: null });
      this.pub.on('error', (e: Error) => log.warn('Redis (pub)', e));
      this.sub.on('error', (e: Error) => log.warn('Redis (sub)', e));
      await this.sub.subscribe(this.channel);
      this.sub.on('message', (_ch: string, raw: string) => {
        try {
          const msg = JSON.parse(raw) as BusMessage & { origin?: string };
          if (msg.origin === instanceId) return;
          this.local.emit(msg.userId, msg);
          this.local.emit('*', msg);
        } catch (err) {
          log.warn('Ungueltige Redis-Nachricht', err);
        }
      });
      log.info('Redis verbunden.');
    } catch (err) {
      log.warn('Redis nicht nutzbar, laufe prozessintern weiter.', err);
      this.pub = null;
      this.sub = null;
    }
  }

  publish(userId: string, event: AppEvent): void {
    const msg: BusMessage = { userId, event };
    this.local.emit(userId, msg);
    this.local.emit('*', msg);
    if (this.pub) {
      this.pub.publish(this.channel, JSON.stringify({ ...msg, origin: instanceId })).catch(() => undefined);
    }
  }

  subscribe(userId: string, handler: Handler): () => void {
    this.local.on(userId, handler);
    return () => this.local.off(userId, handler);
  }

  subscribeAll(handler: Handler): () => void {
    this.local.on('*', handler);
    return () => this.local.off('*', handler);
  }

  async stop(): Promise<void> {
    await this.sub?.quit().catch(() => undefined);
    await this.pub?.quit().catch(() => undefined);
  }
}

const instanceId = Math.random().toString(36).slice(2);
export const bus = new Bus();
