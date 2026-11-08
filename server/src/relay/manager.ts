import { config, type PlatformId } from '../config';
import { bus } from '../lib/bus';
import { maxConcurrentStreams } from '../lib/appSettings';
import { logger } from '../lib/log';
import { getUserByIngestKey, getUserById, type UserRow } from '../lib/users';
import { IngestMonitor, kickPublisher } from '../ingest/mediamtx';
import { StreamSession, type RelayTarget } from './session';
import { thumbnails } from './thumbnail';
import type { SignalInfo } from '../types';

const log = logger('manager');

const EMPTY_SIGNAL: SignalInfo = {
  active: false,
  source: 'none',
  width: null,
  height: null,
  fps: null,
  videoCodec: '',
  audioCodec: '',
  bitrateKbps: null,
  since: null,
  sessionId: null,
  warnings: [],
};

/**
 * Hält pro Nutzer höchstens eine Sitzung und verbindet die Ingest-Überwachung
 * mit den Relays. Erzwingt außerdem das Limit gleichzeitiger Streams.
 */
class RelayManager {
  private readonly sessions = new Map<string, StreamSession>();
  private readonly monitor = new IngestMonitor(2000);

  start(): void {
    this.monitor.handlers({
      start: (obs) => {
        void this.handleStart(obs.ingestKey, obs.bitrateKbps);
      },
      update: (obs) => {
        void this.handleUpdate(obs.ingestKey, obs.bitrateKbps);
      },
      stop: (key) => {
        void this.handleStop(key);
      },
    });
    this.monitor.start();
  }

  async stop(): Promise<void> {
    this.monitor.stop();
    thumbnails.stopAll();
    for (const s of Array.from(this.sessions.values())) await s.destroy();
    this.sessions.clear();
  }

  session(userId: string): StreamSession | null {
    return this.sessions.get(userId) ?? null;
  }

  signal(userId: string): SignalInfo {
    return this.sessions.get(userId)?.signal ?? EMPTY_SIGNAL;
  }

  activeSessions(): { userId: string; session: StreamSession }[] {
    const out: { userId: string; session: StreamSession }[] = [];
    for (const [userId, session] of this.sessions) {
      if (session.signal.active || session.liveCount > 0) out.push({ userId, session });
    }
    return out;
  }

  liveUserCount(): number {
    return this.activeSessions().length;
  }

  private async handleStart(ingestKey: string, bitrateKbps: number | null): Promise<void> {
    const user = await getUserByIngestKey(ingestKey);
    if (!user) {
      log.warn(`Unbekannter Ingest-Key sendet: ${ingestKey.slice(0, 8)}...`);
      return;
    }
    if (user.is_blocked) {
      log.warn(`Gesperrter Nutzer sendet: ${user.email}`);
      await kickPublisher(`${config.ingestPathPrefix}/${ingestKey}`);
      return;
    }

    let session = this.sessions.get(user.id);
    if (!session) {
      // Limit prüfen: zählt nur Nutzer, die nicht schon laufen.
      const limit = await maxConcurrentStreams();
      if (this.liveUserCount() >= limit) {
        log.warn(`Limit erreicht (${limit}) - weise ${user.email} ab.`);
        bus.publish(user.id, { type: 'toast', toast: { level: 'error', code: 'stream_limit_reached' } });
        await kickPublisher(`${config.ingestPathPrefix}/${ingestKey}`);
        return;
      }
      session = new StreamSession(user.id, ingestKey);
      this.sessions.set(user.id, session);
    }
    session.setIngestKey(ingestKey);

    await session.onIngestStart(user, bitrateKbps);
    thumbnails.start(user.id, ingestKey);
  }

  private async handleUpdate(ingestKey: string, bitrateKbps: number | null): Promise<void> {
    const user = await getUserByIngestKey(ingestKey);
    if (!user) return;
    this.sessions.get(user.id)?.onIngestUpdate(bitrateKbps);
  }

  private async handleStop(ingestKey: string): Promise<void> {
    const user = await getUserByIngestKey(ingestKey);
    if (!user) return;
    const session = this.sessions.get(user.id);
    if (!session) return;
    thumbnails.stop(user.id);
    await session.onIngestStop(user);
    if (session.isIdle) this.sessions.delete(user.id);
  }

  /** Startet eine Plattform. Die Ziel-URL kommt aus platforms/resolveTarget. */
  async goLive(userId: string, target: RelayTarget): Promise<void> {
    const session = this.sessions.get(userId);
    if (!session) {
      const err = new Error('no_signal') as Error & { statusCode?: number };
      err.statusCode = 409;
      throw err;
    }
    await session.goLive(target);
  }

  async stopPlatform(userId: string, platform: PlatformId): Promise<void> {
    const session = this.sessions.get(userId);
    if (!session) return;
    await session.stopPlatform(platform);
    if (session.isIdle) {
      await session.destroy();
      this.sessions.delete(userId);
    }
  }

  async stopEverything(userId: string): Promise<void> {
    const session = this.sessions.get(userId);
    if (!session) return;
    await session.stopAll('manual');
    if (session.isIdle) this.sessions.delete(userId);
  }

  /** Nach dem Erneuern eines Ingest-Keys: laufende Sitzung sauber beenden. */
  async dropUser(userId: string): Promise<void> {
    const session = this.sessions.get(userId);
    if (!session) return;
    thumbnails.stop(userId);
    await session.destroy();
    this.sessions.delete(userId);
  }

  async userOf(userId: string): Promise<UserRow | null> {
    return getUserById(userId);
  }
}

export const relayManager = new RelayManager();
