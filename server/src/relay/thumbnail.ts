import * as fs from 'fs';
import * as path from 'path';
import { config, ingestSourceUrl } from '../config';
import { bus } from '../lib/bus';
import { logger } from '../lib/log';
import { spawnFfmpeg, type ManagedProcess } from '../lib/proc';

const log = logger('thumbnail');

const INTERVAL_SEC = 10;

interface Worker {
  proc: ManagedProcess;
  timer: NodeJS.Timeout;
  lastMtime: number;
}

/**
 * Vorschaubild: EIN ffmpeg pro Nutzer schreibt alle 10 Sekunden ein Standbild
 * in dieselbe Datei. Kein Livebild - genau wie im Konzept festgelegt, damit
 * der Server nicht unnötig arbeitet.
 */
export class ThumbnailService {
  private readonly workers = new Map<string, Worker>();

  start(userId: string, ingestKey: string): void {
    if (this.workers.has(userId)) return;
    fs.mkdirSync(config.thumbDir, { recursive: true });
    const file = this.filePath(userId);

    const proc = spawnFfmpeg(
      [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'error',
        '-rw_timeout',
        '15000000',
        '-i',
        ingestSourceUrl(ingestKey),
        '-an',
        '-vf',
        `fps=1/${INTERVAL_SEC},scale=640:-2`,
        '-f',
        'image2',
        '-update',
        '1',
        '-y',
        file,
      ],
      'thumbnail',
    );

    const timer = setInterval(() => {
      const w = this.workers.get(userId);
      if (!w) return;
      try {
        const stat = fs.statSync(file);
        if (stat.mtimeMs !== w.lastMtime) {
          w.lastMtime = stat.mtimeMs;
          bus.publish(userId, {
            type: 'preview',
            url: `/api/stream/preview.jpg?t=${Math.round(stat.mtimeMs)}`,
            at: new Date(stat.mtimeMs).toISOString(),
          });
        }
      } catch {
        /* noch kein Bild */
      }
    }, 2000);
    timer.unref();

    proc.child.on('close', () => {
      const w = this.workers.get(userId);
      if (w && w.proc === proc) {
        clearInterval(w.timer);
        this.workers.delete(userId);
      }
    });

    this.workers.set(userId, { proc, timer, lastMtime: 0 });
    log.debug(`Vorschaubild gestartet für ${userId.slice(0, 8)}`);
  }

  stop(userId: string): void {
    const w = this.workers.get(userId);
    if (!w) return;
    clearInterval(w.timer);
    w.proc.stop();
    this.workers.delete(userId);
  }

  stopAll(): void {
    for (const id of Array.from(this.workers.keys())) this.stop(id);
  }

  filePath(userId: string): string {
    return path.join(config.thumbDir, `${userId}.jpg`);
  }

  exists(userId: string): boolean {
    return fs.existsSync(this.filePath(userId));
  }

  ageSeconds(userId: string): number | null {
    try {
      const stat = fs.statSync(this.filePath(userId));
      return Math.round((Date.now() - stat.mtimeMs) / 1000);
    } catch {
      return null;
    }
  }
}

export const thumbnails = new ThumbnailService();
