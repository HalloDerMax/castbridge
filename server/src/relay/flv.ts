import type { Writable } from 'stream';
import { logger } from '../lib/log';

const log = logger('flv');

export const TAG_AUDIO = 8;
export const TAG_VIDEO = 9;
export const TAG_SCRIPT = 18;

export interface FlvTag {
  type: number;
  timestamp: number;
  data: Buffer;
}

/** Standard-FLV-Kopf (Audio + Video) inklusive PreviousTagSize0. */
export function flvHeader(): Buffer {
  const h = Buffer.alloc(13);
  h.write('FLV', 0, 'ascii');
  h[3] = 1; // Version
  h[4] = 0b00000101; // Audio + Video vorhanden
  h.writeUInt32BE(9, 5); // Kopfgröße
  h.writeUInt32BE(0, 9); // PreviousTagSize0
  return h;
}

export function buildTag(type: number, timestamp: number, data: Buffer): Buffer {
  const ts = Math.max(0, Math.round(timestamp));
  const out = Buffer.alloc(11 + data.length + 4);
  out[0] = type;
  out.writeUIntBE(data.length, 1, 3);
  out.writeUIntBE(ts & 0xffffff, 4, 3);
  out[7] = (ts >>> 24) & 0xff;
  out.writeUIntBE(0, 8, 3);
  data.copy(out, 11);
  out.writeUInt32BE(11 + data.length, 11 + data.length);
  return out;
}

export function isVideoKeyframe(tag: FlvTag): boolean {
  if (tag.type !== TAG_VIDEO || tag.data.length < 2) return false;
  const frameType = (tag.data[0] >> 4) & 0x0f;
  const codecId = tag.data[0] & 0x0f;
  if (frameType !== 1) return false;
  // Bei AVC/HEVC zählt nur ein echter NALU-Frame, nicht der Sequenz-Kopf.
  if (codecId === 7 || codecId === 12) return tag.data[1] === 1;
  return true;
}

export function isVideoSequenceHeader(tag: FlvTag): boolean {
  if (tag.type !== TAG_VIDEO || tag.data.length < 2) return false;
  const codecId = tag.data[0] & 0x0f;
  return (codecId === 7 || codecId === 12) && tag.data[1] === 0;
}

/**
 * Profil und Level aus dem AVC-Sequenz-Kopf. Damit lässt sich unterscheiden,
 * ob zwei Quellen wirklich unterschiedlich kodiert sind oder sich nur der
 * Encoder-Fingerabdruck unterscheidet.
 */
export function avcProfileLevel(seq: Buffer): { profile: number; level: number } | null {
  // data[0] Frame/Codec, data[1] AVCPacketType, data[2..4] Composition Time,
  // danach der AVCDecoderConfigurationRecord.
  if (seq.length < 9) return null;
  return { profile: seq[6], level: seq[8] };
}

export function isAudioSequenceHeader(tag: FlvTag): boolean {
  if (tag.type !== TAG_AUDIO || tag.data.length < 2) return false;
  const soundFormat = (tag.data[0] >> 4) & 0x0f;
  return soundFormat === 10 && tag.data[1] === 0; // AAC
}

/** Inkrementeller FLV-Parser für einen Byte-Strom (z. B. ffmpeg-stdout). */
export class FlvParser {
  private buf: Buffer = Buffer.alloc(0);
  private headerDone = false;

  constructor(private readonly onTag: (tag: FlvTag) => void) {}

  push(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);

    if (!this.headerDone) {
      if (this.buf.length < 13) return;
      if (this.buf.subarray(0, 3).toString('ascii') !== 'FLV') {
        log.warn('Kein FLV-Kopf im Eingang - Strom wird verworfen.');
        this.buf = Buffer.alloc(0);
        return;
      }
      const headerSize = this.buf.readUInt32BE(5);
      const skip = headerSize + 4;
      if (this.buf.length < skip) return;
      this.buf = this.buf.subarray(skip);
      this.headerDone = true;
    }

    for (;;) {
      if (this.buf.length < 11) return;
      const dataSize = this.buf.readUIntBE(1, 3);
      const total = 11 + dataSize + 4;
      if (this.buf.length < total) return;
      const type = this.buf[0];
      const tsLow = this.buf.readUIntBE(4, 3);
      const tsHigh = this.buf[7];
      const timestamp = ((tsHigh << 24) >>> 0) + tsLow;
      const data = Buffer.from(this.buf.subarray(11, 11 + dataSize));
      this.buf = this.buf.subarray(total);
      if (type === TAG_AUDIO || type === TAG_VIDEO || type === TAG_SCRIPT) {
        this.onTag({ type, timestamp, data });
      }
    }
  }

  reset(): void {
    this.buf = Buffer.alloc(0);
    this.headerDone = false;
  }
}

interface Output {
  id: string;
  stream: Writable;
  awaitKeyframe: boolean;
  dropped: number;
  sentVideoSeq: Buffer | null;
  sentAudioSeq: Buffer | null;
}

const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

/**
 * Setzt mehrere Quellen (OBS, Ersatzbild) zu EINEM durchgehenden FLV-Strom
 * zusammen und schreibt ihn an beliebig viele Ausgänge (ein ffmpeg pro
 * Plattform).
 *
 * Der Witz: die Ausgänge sehen nie ein Dateiende. Wird die Quelle gewechselt,
 * laufen die Zeitstempel lückenlos weiter, und der Wechsel passiert immer auf
 * einem Keyframe. Dadurch bleibt die RTMP-Verbindung zu Twitch/YouTube/Kick
 * bestehen, obwohl das Quellmaterial getauscht wurde.
 *
 * Neue Ausgänge können jederzeit dazukommen: sie erhalten Kopf, Metadaten und
 * Sequenz-Köpfe und steigen beim nächsten Keyframe ein.
 */
export class FlvSplicer {
  private readonly outputs = new Map<string, Output>();
  private metadata: Buffer | null = null;
  private videoSeq: Buffer | null = null;
  private audioSeq: Buffer | null = null;

  private activeSource: string | null = null;
  private pendingSource: string | null = null;

  private readonly srcSeq = new Map<string, { video: Buffer | null; audio: Buffer | null }>();
  private readonly srcOffset = new Map<string, number>();
  private readonly srcLastIn = new Map<string, number>();
  /** Letzter ausgegebener Zeitstempel je Spur (Audio/Video). */
  private readonly outPerType = new Map<number, number>();

  private outTs = 0;
  private frameGapMs = 33;
  private switchCount = 0;

  constructor(private readonly scope: string) {}

  get currentSource(): string | null {
    return this.activeSource;
  }

  get outputCount(): number {
    return this.outputs.size;
  }

  get timestampMs(): number {
    return this.outTs;
  }

  get switches(): number {
    return this.switchCount;
  }

  setFrameRate(fps: number | null | undefined): void {
    if (fps && fps > 0 && fps <= 240) this.frameGapMs = 1000 / fps;
  }

  /** Quelle anmelden. Der Wechsel erfolgt erst beim nächsten Keyframe. */
  requestSource(sourceId: string): void {
    if (this.activeSource === sourceId) {
      this.pendingSource = null;
      return;
    }
    this.pendingSource = sourceId;
  }

  /** Quelle ist weggefallen (Prozess beendet). */
  dropSource(sourceId: string): void {
    this.srcSeq.delete(sourceId);
    this.srcOffset.delete(sourceId);
    this.srcLastIn.delete(sourceId);
    if (this.activeSource === sourceId) this.activeSource = null;
    if (this.pendingSource === sourceId) this.pendingSource = null;
  }

  addOutput(id: string, stream: Writable): void {
    const out: Output = {
      id,
      stream,
      awaitKeyframe: true,
      dropped: 0,
      sentVideoSeq: null,
      sentAudioSeq: null,
    };
    this.outputs.set(id, out);
    this.writeInit(out);
  }

  removeOutput(id: string): void {
    this.outputs.delete(id);
  }

  hasOutput(id: string): boolean {
    return this.outputs.has(id);
  }

  private writeInit(out: Output): void {
    this.safeWrite(out, flvHeader());
    if (this.metadata) this.safeWrite(out, buildTag(TAG_SCRIPT, 0, this.metadata));
    if (this.videoSeq) {
      this.safeWrite(out, buildTag(TAG_VIDEO, 0, this.videoSeq));
      out.sentVideoSeq = this.videoSeq;
    }
    if (this.audioSeq) {
      this.safeWrite(out, buildTag(TAG_AUDIO, 0, this.audioSeq));
      out.sentAudioSeq = this.audioSeq;
    }
  }

  private safeWrite(out: Output, buf: Buffer): boolean {
    const stream = out.stream;
    if (stream.destroyed || stream.writableEnded) {
      this.outputs.delete(out.id);
      return false;
    }
    try {
      stream.write(buf);
      return true;
    } catch {
      this.outputs.delete(out.id);
      return false;
    }
  }

  /** Ein Tag einer Quelle einspeisen. */
  feed(sourceId: string, tag: FlvTag): void {
    // Sequenz-Köpfe jeder Quelle merken, auch wenn sie noch nicht aktiv ist.
    if (isVideoSequenceHeader(tag) || isAudioSequenceHeader(tag) || tag.type === TAG_SCRIPT) {
      const entry = this.srcSeq.get(sourceId) ?? { video: null, audio: null };
      if (isVideoSequenceHeader(tag)) entry.video = tag.data;
      if (isAudioSequenceHeader(tag)) entry.audio = tag.data;
      this.srcSeq.set(sourceId, entry);
      if (tag.type === TAG_SCRIPT && this.metadata === null) this.metadata = tag.data;
      if (this.activeSource === sourceId) {
        if (isVideoSequenceHeader(tag)) this.videoSeq = tag.data;
        if (isAudioSequenceHeader(tag)) this.audioSeq = tag.data;
      }
      // Sequenz-Köpfe nie direkt weiterschicken - das macht der Einstieg.
      return;
    }

    // Erste Quelle überhaupt oder Wechsel: nur auf Keyframe.
    if (this.activeSource === null || this.pendingSource === sourceId) {
      if (!isVideoKeyframe(tag)) return;
      this.activate(sourceId, tag.timestamp);
    }

    if (sourceId !== this.activeSource) return;

    // Zeitstempel der Quelle kann bei einer Schleife zurückspringen.
    const lastIn = this.srcLastIn.get(sourceId);
    if (lastIn !== undefined && tag.timestamp + 500 < lastIn) {
      this.srcOffset.set(sourceId, this.outTs + this.frameGapMs - tag.timestamp);
    }
    this.srcLastIn.set(sourceId, tag.timestamp);

    const offset = this.srcOffset.get(sourceId) ?? 0;
    let ts = Math.max(this.outTs - 2000, tag.timestamp + offset);

    // Innerhalb einer Spur dürfen die Zeitstempel nie zurückgehen, sonst
    // lehnen strenge Muxer den Strom ab ("non monotonically increasing dts").
    // Zwischen Audio und Video ist Verzahnung dagegen normal und erlaubt.
    const lastSameType = this.outPerType.get(tag.type);
    if (lastSameType !== undefined && ts <= lastSameType) ts = lastSameType + 1;
    this.outPerType.set(tag.type, ts);

    if (ts > this.outTs) this.outTs = ts;

    const keyframe = isVideoKeyframe(tag);
    const buf = buildTag(tag.type, ts, tag.data);

    for (const out of Array.from(this.outputs.values())) {
      if (out.awaitKeyframe) {
        if (!keyframe) continue;
        out.awaitKeyframe = false;
      }
      const buffered = (out.stream as unknown as { writableLength?: number }).writableLength ?? 0;
      if (buffered > MAX_BUFFERED_BYTES && !keyframe) {
        out.dropped += 1;
        if (out.dropped % 200 === 1) {
          log.warn(`${this.scope}: Ausgang ${out.id} haengt (${Math.round(buffered / 1024)} KB im Puffer).`);
        }
        continue;
      }
      this.safeWrite(out, buf);
    }
  }

  private activate(sourceId: string, firstTs: number): void {
    const previous = this.activeSource;
    this.activeSource = sourceId;
    this.pendingSource = null;
    this.srcOffset.set(sourceId, (previous === null ? 0 : this.outTs + this.frameGapMs) - firstTs);
    this.srcLastIn.set(sourceId, firstTs);

    const seq = this.srcSeq.get(sourceId);
    const previousVideoSeq = this.videoSeq;
    const newVideo = seq?.video ?? this.videoSeq;
    const newAudio = seq?.audio ?? this.audioSeq;
    const videoChanged = newVideo !== null && (this.videoSeq === null || !newVideo.equals(this.videoSeq));
    const audioChanged = newAudio !== null && (this.audioSeq === null || !newAudio.equals(this.audioSeq));
    this.videoSeq = newVideo ?? null;
    this.audioSeq = newAudio ?? null;

    if (previous !== null) {
      this.switchCount += 1;
      log.info(`${this.scope}: Quelle gewechselt ${previous} -> ${sourceId} bei ${Math.round(this.outTs)} ms`);

      if (videoChanged && newVideo) {
        const before = previousVideoSeq ? avcProfileLevel(previousVideoSeq) : null;
        const after = avcProfileLevel(newVideo);
        const sameShape =
          before !== null && after !== null && before.profile === after.profile && before.level === after.level;

        if (sameShape) {
          // Normalfall: zwei Encoder-Läufe erzeugen nie byte-gleiche
          // Sequenz-Köpfe. Profil und Level stimmen, das nehmen die
          // Plattformen auf einem Keyframe an.
          log.debug(
            `${this.scope}: Sequenz-Koepfe unterscheiden sich, Profil und Level stimmen ` +
              `(Profil ${after.profile}, Level ${after.level}).`,
          );
        } else {
          log.warn(
            `${this.scope}: Profil oder Level der neuen Quelle weichen ab ` +
              `(vorher ${before ? `${before.profile}/${before.level}` : '?'}, ` +
              `jetzt ${after ? `${after.profile}/${after.level}` : '?'}). ` +
              'Das Ersatzmedium passt nicht zum OBS-Signal, Plattformen koennen dabei abbrechen.',
          );
        }
      }
      if (audioChanged) {
        log.debug(`${this.scope}: Audio-Sequenz-Kopf der neuen Quelle weicht ab.`);
      }
    }

    for (const out of Array.from(this.outputs.values())) {
      if (videoChanged && this.videoSeq) {
        this.safeWrite(out, buildTag(TAG_VIDEO, this.outTs, this.videoSeq));
        out.sentVideoSeq = this.videoSeq;
      }
      if (audioChanged && this.audioSeq) {
        this.safeWrite(out, buildTag(TAG_AUDIO, this.outTs, this.audioSeq));
        out.sentAudioSeq = this.audioSeq;
      }
    }
  }

  reset(): void {
    this.outputs.clear();
    this.metadata = null;
    this.videoSeq = null;
    this.audioSeq = null;
    this.activeSource = null;
    this.pendingSource = null;
    this.srcSeq.clear();
    this.srcOffset.clear();
    this.srcLastIn.clear();
    this.outPerType.clear();
    this.outTs = 0;
    this.switchCount = 0;
  }
}
