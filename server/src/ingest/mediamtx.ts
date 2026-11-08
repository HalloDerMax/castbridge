import { config } from '../config';
import { getJson } from '../lib/http';
import { logger } from '../lib/log';

const log = logger('mediamtx');

export interface MtxPath {
  name: string;
  ready: boolean;
  readyTime: string | null;
  tracks: string[];
  bytesReceived: number;
  source: { type: string; id: string } | null;
  readers: { type: string; id: string }[];
}

interface MtxPathList {
  itemCount: number;
  pageCount: number;
  items: MtxPath[];
}

export async function listPaths(): Promise<MtxPath[]> {
  const res = await getJson<MtxPathList>(`${config.mediamtxApiUrl}/v3/paths/list?itemsPerPage=500`, {
    timeoutMs: 5000,
  });
  return res.items ?? [];
}

export async function kickPublisher(pathName: string): Promise<void> {
  try {
    const conns = await getJson<{ items: { id: string; path: string }[] }>(
      `${config.mediamtxApiUrl}/v3/rtmpconns/list?itemsPerPage=500`,
      { timeoutMs: 5000 },
    );
    for (const c of conns.items ?? []) {
      if (c.path === pathName) {
        await getJson(`${config.mediamtxApiUrl}/v3/rtmpconns/kick/${c.id}`, { method: 'POST', timeoutMs: 5000 });
      }
    }
  } catch (err) {
    log.warn('Publisher konnte nicht getrennt werden', err);
  }
}

export async function mediamtxReachable(): Promise<boolean> {
  try {
    await listPaths();
    return true;
  } catch {
    return false;
  }
}

export interface IngestObservation {
  /** Ingest-Key = letzter Teil des Pfads. */
  ingestKey: string;
  pathName: string;
  tracks: string[];
  /** Aus der Byte-Differenz errechnet, also der tatsächlich ankommende Wert. */
  bitrateKbps: number | null;
  since: string | null;
}

type StartHandler = (obs: IngestObservation) => void;
type StopHandler = (ingestKey: string) => void;
type UpdateHandler = (obs: IngestObservation) => void;

interface Tracked {
  bytes: number;
  at: number;
  bitrateKbps: number | null;
  since: string | null;
  missingTicks: number;
}

/**
 * Fragt MediaMTX im Takt ab und meldet, welcher Nutzer gerade sendet.
 * Die Bitrate wird aus der Byte-Differenz berechnet - das ist der Wert, der
 * wirklich ankommt, nicht der, den OBS behauptet.
 */
export class IngestMonitor {
  private timer: NodeJS.Timeout | null = null;
  private readonly tracked = new Map<string, Tracked>();
  private onStart: StartHandler = () => undefined;
  private onStop: StopHandler = () => undefined;
  private onUpdate: UpdateHandler = () => undefined;
  private warnedUnreachable = false;

  constructor(private readonly intervalMs = 2000) {}

  handlers(h: { start: StartHandler; stop: StopHandler; update: UpdateHandler }): void {
    this.onStart = h.start;
    this.onStop = h.stop;
    this.onUpdate = h.update;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref();
    log.info(`Ingest-Überwachung gestartet (alle ${this.intervalMs} ms).`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    let paths: MtxPath[];
    try {
      paths = await listPaths();
      this.warnedUnreachable = false;
    } catch (err) {
      if (!this.warnedUnreachable) {
        log.warn('MediaMTX nicht erreichbar', err);
        this.warnedUnreachable = true;
      }
      return;
    }

    const prefix = `${config.ingestPathPrefix}/`;
    const seen = new Set<string>();
    const now = Date.now();

    for (const p of paths) {
      if (!p.name.startsWith(prefix) || !p.ready) continue;
      const ingestKey = p.name.slice(prefix.length);
      if (ingestKey === '') continue;
      seen.add(ingestKey);

      const prev = this.tracked.get(ingestKey);
      if (!prev) {
        this.tracked.set(ingestKey, {
          bytes: p.bytesReceived,
          at: now,
          bitrateKbps: null,
          since: p.readyTime,
          missingTicks: 0,
        });
        this.onStart({
          ingestKey,
          pathName: p.name,
          tracks: p.tracks ?? [],
          bitrateKbps: null,
          since: p.readyTime,
        });
        continue;
      }

      const dtSec = (now - prev.at) / 1000;
      let bitrate = prev.bitrateKbps;
      if (dtSec >= 1 && p.bytesReceived >= prev.bytes) {
        const instant = ((p.bytesReceived - prev.bytes) * 8) / dtSec / 1000;
        // Leicht geglättet, damit die Anzeige nicht zappelt.
        bitrate = prev.bitrateKbps === null ? instant : prev.bitrateKbps * 0.6 + instant * 0.4;
        bitrate = Math.round(bitrate);
      }
      this.tracked.set(ingestKey, {
        bytes: p.bytesReceived,
        at: now,
        bitrateKbps: bitrate,
        since: prev.since ?? p.readyTime,
        missingTicks: 0,
      });
      this.onUpdate({
        ingestKey,
        pathName: p.name,
        tracks: p.tracks ?? [],
        bitrateKbps: bitrate,
        since: prev.since ?? p.readyTime,
      });
    }

    for (const [key, entry] of Array.from(this.tracked.entries())) {
      if (seen.has(key)) continue;
      // Zwei Fehlschläge Toleranz, damit ein einzelner API-Hickser nichts auslöst.
      entry.missingTicks += 1;
      if (entry.missingTicks >= 2) {
        this.tracked.delete(key);
        this.onStop(key);
      }
    }
  }
}
