import { config, ingestSourceUrl, PLATFORMS, type PlatformId } from '../config';
import { bus } from '../lib/bus';
import { exec, one } from '../lib/db';
import { logger } from '../lib/log';
import { errorTail, probe, spawnFfmpeg, type ManagedProcess } from '../lib/proc';
import { mergeSettings, type UserRow } from '../lib/users';
import type { PlatformState, SignalInfo, SignalWarning } from '../types';
import { FlvParser, FlvSplicer } from './flv';
import { FALLBACK_PARAMS, prepareStandby, type StreamParams } from './standby';

const log = logger('relay');

const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [1500, 4000, 9000];
const STANDBY_MAX_MS = 10 * 60 * 1000;
const SWITCH_TIMEOUT_MS = 12_000;

const SOURCE_OBS = 'obs';
const SOURCE_STANDBY = 'standby';

export interface RelayTarget {
  platform: PlatformId;
  url: string;
}

interface Relay {
  platform: PlatformId;
  url: string;
  proc: ManagedProcess | null;
  state: PlatformState;
  desired: boolean;
  attempt: number;
  startedAt: Date | null;
  lastError: string | null;
  runId: string | null;
  retryTimer: NodeJS.Timeout | null;
}

/**
 * Eine laufende Sitzung eines Nutzers: nimmt das OBS-Signal, hält es über den
 * Splicer durchgehend bereit und bedient pro Plattform einen eigenen
 * ffmpeg-Prozess mit "-c copy" (keine Neukodierung).
 */
export class StreamSession {
  private readonly splicer: FlvSplicer;
  private readonly relays = new Map<PlatformId, Relay>();

  private obsProc: ManagedProcess | null = null;
  private standbyProc: ManagedProcess | null = null;
  private standbySince: number | null = null;
  private standbyTimer: NodeJS.Timeout | null = null;
  private switchWatch: NodeJS.Timeout | null = null;

  private params: StreamParams | null = null;
  private dbSessionId: string | null = null;
  private closed = false;

  private signalState: SignalInfo = {
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

  constructor(
    readonly userId: string,
    private ingestKey: string,
  ) {
    this.splicer = new FlvSplicer(`user:${userId.slice(0, 8)}`);
  }

  // ── Zustand nach außen ────────────────────────────────────

  get signal(): SignalInfo {
    return this.signalState;
  }

  get sessionId(): string | null {
    return this.dbSessionId;
  }

  get isIdle(): boolean {
    return !this.signalState.active && this.relays.size === 0;
  }

  get liveCount(): number {
    let n = 0;
    for (const r of this.relays.values()) if (r.state === 'live' || r.state === 'standby') n += 1;
    return n;
  }

  platformState(platform: PlatformId): { state: PlatformState; attempt: number; since: string | null; lastError: string | null } {
    const r = this.relays.get(platform);
    if (!r) return { state: 'idle', attempt: 0, since: null, lastError: null };
    return {
      state: r.state,
      attempt: r.attempt,
      since: r.startedAt ? r.startedAt.toISOString() : null,
      lastError: r.lastError,
    };
  }

  setIngestKey(key: string): void {
    this.ingestKey = key;
  }

  // ── OBS-Signal ────────────────────────────────────────────

  /** Wird aufgerufen, sobald MediaMTX einen Publisher für diesen Nutzer meldet. */
  async onIngestStart(user: UserRow, bitrateKbps: number | null): Promise<void> {
    if (this.closed) return;

    const url = ingestSourceUrl(this.ingestKey);
    const info = await probe(url, 20_000);

    this.params = {
      width: info?.width ?? FALLBACK_PARAMS.width,
      height: info?.height ?? FALLBACK_PARAMS.height,
      fps: info?.fps ?? FALLBACK_PARAMS.fps,
      bitrateKbps: bitrateKbps ?? info?.bitrateKbps ?? FALLBACK_PARAMS.bitrateKbps,
      audioSampleRate: info?.audioSampleRate ?? FALLBACK_PARAMS.audioSampleRate,
      audioChannels: info?.audioChannels ?? FALLBACK_PARAMS.audioChannels,
      videoProfile: info?.profile ?? FALLBACK_PARAMS.videoProfile,
      videoLevel: info?.level ?? FALLBACK_PARAMS.videoLevel,
    };
    this.splicer.setFrameRate(this.params.fps);

    const resumed = this.dbSessionId !== null;
    if (!resumed) {
      const row = await one<{ id: string }>(
        `INSERT INTO stream_sessions (user_id, video_codec, audio_codec, width, height, fps, bitrate_kbps)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          this.userId,
          info?.videoCodec ?? '',
          info?.audioCodec ?? '',
          this.params.width,
          this.params.height,
          this.params.fps,
          this.params.bitrateKbps,
        ],
      );
      this.dbSessionId = row?.id ?? null;
    }

    this.signalState = {
      active: true,
      source: 'obs',
      width: info?.width ?? null,
      height: info?.height ?? null,
      fps: info?.fps ?? null,
      videoCodec: info?.videoCodec ?? '',
      audioCodec: info?.audioCodec ?? '',
      bitrateKbps: bitrateKbps ?? info?.bitrateKbps ?? null,
      since: new Date().toISOString(),
      sessionId: this.dbSessionId,
      warnings: this.buildWarnings(info?.videoCodec ?? '', info?.audioCodec ?? '', bitrateKbps ?? info?.bitrateKbps ?? null, info?.fps ?? null, info?.height ?? null),
    };

    this.startObsSource();
    this.emitSignal();

    if (resumed) {
      bus.publish(this.userId, { type: 'toast', toast: { level: 'success', code: 'obs_back' } });
      this.splicer.requestSource(SOURCE_OBS);
      this.watchForSwitch(SOURCE_OBS, () => this.stopStandbySource());
    } else {
      log.info(`Signal empfangen: ${this.userId.slice(0, 8)} ${this.params.width}x${this.params.height}@${this.params.fps}`);
    }

    // Ersatzbild im Hintergrund passend vorbereiten.
    const settings = mergeSettings(user.settings);
    if (settings.standbyEnabled) {
      void prepareStandby(this.userId, this.params).catch((err) => log.warn('Ersatzbild', err));
    }
  }

  onIngestUpdate(bitrateKbps: number | null): void {
    if (!this.signalState.active || this.signalState.source !== 'obs') return;
    if (bitrateKbps === null) return;
    const prev = this.signalState.bitrateKbps;
    if (prev !== null && Math.abs(prev - bitrateKbps) < 50) return;
    this.signalState = {
      ...this.signalState,
      bitrateKbps,
      warnings: this.buildWarnings(
        this.signalState.videoCodec,
        this.signalState.audioCodec,
        bitrateKbps,
        this.signalState.fps,
        this.signalState.height,
      ),
    };
    this.emitSignal();
  }

  /** OBS ist weg: entweder überbrücken oder alles beenden. */
  async onIngestStop(user: UserRow): Promise<void> {
    if (this.closed) return;
    this.stopObsSource();

    const settings = mergeSettings(user.settings);
    const anyDesired = Array.from(this.relays.values()).some((r) => r.desired);

    if (!anyDesired || !settings.standbyEnabled) {
      this.signalState = { ...this.signalState, active: false, source: 'none', bitrateKbps: null };
      this.emitSignal();
      bus.publish(this.userId, { type: 'toast', toast: { level: 'warn', code: 'obs_lost' } });
      await this.stopAll('obs_gone');
      return;
    }

    const prepared = await prepareStandby(this.userId, this.params ?? FALLBACK_PARAMS);
    if (!prepared) {
      bus.publish(this.userId, { type: 'toast', toast: { level: 'error', code: 'standby_failed' } });
      await this.stopAll('standby_failed');
      return;
    }

    this.startStandbySource(prepared.file);
    this.signalState = { ...this.signalState, active: true, source: 'standby', bitrateKbps: null };
    this.emitSignal();
    for (const r of this.relays.values()) {
      if (r.state === 'live') this.setState(r, 'standby');
    }
    bus.publish(this.userId, { type: 'toast', toast: { level: 'warn', code: 'standby_active' } });

    this.standbySince = Date.now();
    if (this.standbyTimer) clearTimeout(this.standbyTimer);
    this.standbyTimer = setTimeout(() => {
      log.info(`Ersatzbild läuft zu lange - Sitzung ${this.userId.slice(0, 8)} wird beendet.`);
      bus.publish(this.userId, { type: 'toast', toast: { level: 'warn', code: 'standby_timeout' } });
      void this.stopAll('standby_timeout');
    }, STANDBY_MAX_MS);
    this.standbyTimer.unref();
  }

  // ── Quellen ───────────────────────────────────────────────

  private startObsSource(): void {
    if (this.obsProc) return;
    const url = ingestSourceUrl(this.ingestKey);
    const proc = spawnFfmpeg(
      [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'warning',
        '-rw_timeout',
        '15000000',
        '-i',
        url,
        '-c',
        'copy',
        '-f',
        'flv',
        '-flvflags',
        'no_duration_filesize',
        'pipe:1',
      ],
      'obs-source',
    );
    const parser = new FlvParser((tag) => this.splicer.feed(SOURCE_OBS, tag));
    proc.child.stdout.on('data', (d: Buffer) => parser.push(d));
    proc.child.on('close', () => {
      this.splicer.dropSource(SOURCE_OBS);
      if (this.obsProc === proc) this.obsProc = null;
    });
    this.obsProc = proc;
    this.splicer.requestSource(SOURCE_OBS);
  }

  private stopObsSource(): void {
    if (!this.obsProc) return;
    this.obsProc.stop();
    this.obsProc = null;
    this.splicer.dropSource(SOURCE_OBS);
  }

  private startStandbySource(file: string): void {
    if (this.standbyProc) return;
    const proc = spawnFfmpeg(
      [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'warning',
        '-re',
        '-stream_loop',
        '-1',
        '-i',
        file,
        '-c',
        'copy',
        '-f',
        'flv',
        '-flvflags',
        'no_duration_filesize',
        'pipe:1',
      ],
      'standby-source',
    );
    const parser = new FlvParser((tag) => this.splicer.feed(SOURCE_STANDBY, tag));
    proc.child.stdout.on('data', (d: Buffer) => parser.push(d));
    proc.child.on('close', () => {
      this.splicer.dropSource(SOURCE_STANDBY);
      if (this.standbyProc === proc) this.standbyProc = null;
    });
    this.standbyProc = proc;
    this.splicer.requestSource(SOURCE_STANDBY);
  }

  private stopStandbySource(): void {
    if (this.standbyTimer) {
      clearTimeout(this.standbyTimer);
      this.standbyTimer = null;
    }
    this.standbySince = null;
    if (!this.standbyProc) return;
    this.standbyProc.stop();
    this.standbyProc = null;
    this.splicer.dropSource(SOURCE_STANDBY);
    for (const r of this.relays.values()) {
      if (r.state === 'standby') this.setState(r, 'live');
    }
    bus.publish(this.userId, { type: 'toast', toast: { level: 'success', code: 'standby_ended' } });
  }

  /** Wartet, bis der Splicer wirklich auf die neue Quelle umgeschaltet hat. */
  private watchForSwitch(sourceId: string, done: () => void): void {
    if (this.switchWatch) clearInterval(this.switchWatch);
    const deadline = Date.now() + SWITCH_TIMEOUT_MS;
    this.switchWatch = setInterval(() => {
      if (this.splicer.currentSource === sourceId) {
        if (this.switchWatch) clearInterval(this.switchWatch);
        this.switchWatch = null;
        done();
      } else if (Date.now() > deadline) {
        if (this.switchWatch) clearInterval(this.switchWatch);
        this.switchWatch = null;
        log.warn(`Umschalten auf ${sourceId} hat nicht geklappt - alte Quelle bleibt.`);
        done();
      }
    }, 400);
    this.switchWatch.unref();
  }

  // ── Plattformen ───────────────────────────────────────────

  async goLive(target: RelayTarget): Promise<void> {
    if (!this.signalState.active) {
      const err = new Error('no_signal') as Error & { statusCode?: number };
      err.statusCode = 409;
      throw err;
    }
    const existing = this.relays.get(target.platform);
    if (existing && (existing.state === 'live' || existing.state === 'starting' || existing.state === 'standby')) return;

    const relay: Relay = existing ?? {
      platform: target.platform,
      url: target.url,
      proc: null,
      state: 'idle',
      desired: true,
      attempt: 0,
      startedAt: null,
      lastError: null,
      runId: null,
      retryTimer: null,
    };
    relay.url = target.url;
    relay.desired = true;
    relay.attempt = 0;
    relay.lastError = null;
    this.relays.set(target.platform, relay);

    if (this.dbSessionId) {
      const row = await one<{ id: string }>(
        `INSERT INTO platform_runs (session_id, user_id, platform, state) VALUES ($1, $2, $3, 'live') RETURNING id`,
        [this.dbSessionId, this.userId, target.platform],
      );
      relay.runId = row?.id ?? null;
    }

    this.spawnRelay(relay);
  }

  private spawnRelay(relay: Relay): void {
    this.setState(relay, 'starting');
    const proc = spawnFfmpeg(
      [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'warning',
        '-f',
        'flv',
        '-probesize',
        '500000',
        '-analyzeduration',
        '1000000',
        '-i',
        'pipe:0',
        '-c',
        'copy',
        '-f',
        'flv',
        '-flvflags',
        'no_duration_filesize',
        relay.url,
      ],
      `relay:${relay.platform}`,
    );
    relay.proc = proc;
    relay.startedAt = new Date();

    proc.child.stdin.on('error', () => undefined);
    this.splicer.addOutput(relay.platform, proc.child.stdin);

    // Nach kurzer Zeit ohne Absturz gilt die Verbindung als stehend.
    const confirm = setTimeout(() => {
      if (relay.proc === proc && relay.desired && relay.state === 'starting') {
        this.setState(relay, this.signalState.source === 'standby' ? 'standby' : 'live');
        relay.attempt = 0;
      }
    }, 2500);
    confirm.unref();

    proc.child.on('close', (code) => {
      clearTimeout(confirm);
      this.splicer.removeOutput(relay.platform);
      if (relay.proc !== proc) return;
      relay.proc = null;

      if (!relay.desired || this.closed) {
        this.setState(relay, 'idle');
        return;
      }

      const detail = errorTail(proc);
      relay.lastError = detail === '' ? `ffmpeg beendet (${code})` : detail;
      log.warn(`${relay.platform}: Verbindung verloren (${code}) ${relay.lastError}`);

      if (relay.attempt < MAX_RETRIES) {
        relay.attempt += 1;
        this.setState(relay, 'reconnecting');
        bus.publish(this.userId, {
          type: 'toast',
          toast: {
            level: 'warn',
            code: 'relay_reconnecting',
            platform: relay.platform,
            detail: `${relay.attempt}/${MAX_RETRIES}`,
          },
        });
        const delay = RETRY_DELAYS_MS[Math.min(relay.attempt - 1, RETRY_DELAYS_MS.length - 1)];
        relay.retryTimer = setTimeout(() => {
          relay.retryTimer = null;
          if (relay.desired && !this.closed && this.signalState.active) this.spawnRelay(relay);
          else this.setState(relay, 'idle');
        }, delay);
        relay.retryTimer.unref();
        return;
      }

      relay.desired = false;
      this.setState(relay, 'error');
      bus.publish(this.userId, {
        type: 'toast',
        toast: {
          level: 'error',
          code: 'relay_failed',
          platform: relay.platform,
          detail: relay.lastError ?? undefined,
          retryable: true,
        },
      });
      void this.closeRun(relay, 'error');
    });
  }

  async stopPlatform(platform: PlatformId): Promise<void> {
    const relay = this.relays.get(platform);
    if (!relay) return;
    relay.desired = false;
    if (relay.retryTimer) {
      clearTimeout(relay.retryTimer);
      relay.retryTimer = null;
    }
    this.setState(relay, 'stopping');
    this.splicer.removeOutput(platform);
    relay.proc?.stop();
    relay.proc = null;
    this.setState(relay, 'idle');
    await this.closeRun(relay, 'stopped');
    this.relays.delete(platform);
  }

  async stopAll(reason: string): Promise<void> {
    for (const platform of Array.from(this.relays.keys())) {
      await this.stopPlatform(platform);
    }
    this.stopStandbySource();
    this.stopObsSource();
    this.splicer.reset();
    this.signalState = {
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
    this.emitSignal();
    if (this.dbSessionId) {
      await exec('UPDATE stream_sessions SET ended_at = now() WHERE id = $1 AND ended_at IS NULL', [this.dbSessionId]);
      this.dbSessionId = null;
    }
    log.info(`Sitzung beendet (${reason}): ${this.userId.slice(0, 8)}`);
  }

  async destroy(): Promise<void> {
    this.closed = true;
    if (this.switchWatch) clearInterval(this.switchWatch);
    await this.stopAll('destroy');
  }

  private async closeRun(relay: Relay, state: string): Promise<void> {
    if (!relay.runId) return;
    await exec('UPDATE platform_runs SET ended_at = now(), state = $2, last_error = $3 WHERE id = $1', [
      relay.runId,
      state,
      relay.lastError,
    ]);
    relay.runId = null;
  }

  private setState(relay: Relay, state: PlatformState): void {
    if (relay.state === state) return;
    relay.state = state;
    bus.publish(this.userId, {
      type: 'platform',
      status: {
        platform: relay.platform,
        connected: true,
        connectedVia: null,
        channelName: '',
        state,
        viewers: null,
        simulatedViewers: 0,
        since: relay.startedAt ? relay.startedAt.toISOString() : null,
        attempt: relay.attempt,
        lastError: relay.lastError,
        title: '',
        category: '',
        capabilities: {
          oauth: false,
          streamKeyViaApi: false,
          setTitle: false,
          setCategory: false,
          categoryMode: 'none',
          chat: false,
          viewers: false,
          events: false,
        },
      },
    });
  }

  private emitSignal(): void {
    bus.publish(this.userId, { type: 'signal', signal: this.signalState });
  }

  private buildWarnings(
    videoCodec: string,
    audioCodec: string,
    bitrateKbps: number | null,
    fps: number | null,
    height: number | null,
  ): SignalWarning[] {
    const out: SignalWarning[] = [];
    if (bitrateKbps !== null && bitrateKbps > config.twitchMaxBitrateKbps) {
      out.push({ code: 'bitrate_high', platform: 'twitch', value: bitrateKbps, limit: config.twitchMaxBitrateKbps });
    }
    const codec = videoCodec.toLowerCase();
    if (codec !== '' && codec !== 'h264' && codec !== 'avc1') {
      for (const p of PLATFORMS) {
        out.push({ code: 'codec_unsupported', platform: p, value: videoCodec });
      }
    }
    if (audioCodec === '') out.push({ code: 'audio_missing' });
    if (fps !== null && fps > 61) out.push({ code: 'fps_high', value: fps, limit: 60 });
    if (height !== null && height > 1080) out.push({ code: 'resolution_high', value: `${height}p`, limit: '1080p' });
    return out;
  }

  /** Diagnose für den Admin-Bereich. */
  diagnostics(): {
    outputs: number;
    source: string | null;
    switches: number;
    timestampMs: number;
    standbySeconds: number | null;
  } {
    return {
      outputs: this.splicer.outputCount,
      source: this.splicer.currentSource,
      switches: this.splicer.switches,
      timestampMs: Math.round(this.splicer.timestampMs),
      standbySeconds: this.standbySince === null ? null : Math.round((Date.now() - this.standbySince) / 1000),
    };
  }
}
